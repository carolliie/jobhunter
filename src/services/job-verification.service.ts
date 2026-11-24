import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { Job } from "../types";
import { htmlToText } from "../utils/text";

export type AuthenticityStatus = "verified" | "partially_verified" | "unverified" | "suspicious";

export interface VerificationResult {
  status: AuthenticityStatus;
  checkedUrl: string;
  finalUrl?: string;
  httpStatus?: number;
  evidence: string[];
  warnings: string[];
  missing: string[];
  checkedAt: string;
}

/** Hosts de ATS (Applicant Tracking System) onde a empresa publica a própria vaga. */
const TRUSTED_ATS = [/(^|\.)greenhouse\.io$/i, /(^|\.)lever\.co$/i];
const AGGREGATORS = [/(^|\.)remotive\.com$/i];
/** Sites que proíbem acesso automatizado: nunca baixamos essas páginas (só avaliamos o domínio). */
const NO_FETCH = [/(^|\.)linkedin\.com$/i, /(^|\.)indeed\.(com|com\.br)$/i, /(^|\.)glassdoor\.(com|com\.br)$/i, /(^|\.)adzuna\.(com|com\.br)$/i, /(^|\.)jooble\.org$/i];
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy|ow\.ly|shorturl\.at|tiny\.cc|wa\.me|t\.me|linktr\.ee)$/i;

/** IPs que nunca devem ser acessados a partir de URLs externas (SSRF). */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return /^(fc|fd|fe[89ab])/.test(l) || l.startsWith("ff");
  }
  return true;
}

/** lookup do socket: valida o IP no momento da conexão (evita DNS rebinding). */
const safeLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addrs) => {
    if (err) return (cb as any)(err);
    const list = (addrs as dns.LookupAddress[]) ?? [];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
      return (cb as any)(new Error("endereço de rede interno bloqueado"));
    }
    if ((options as dns.LookupOptions).all) return (cb as any)(null, list);
    return (cb as any)(null, list[0]!.address, list[0]!.family);
  });
};

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 8000 } });

export function validateExternalUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocolo não permitido");
  if (u.username || u.password) throw new Error("URL contém credenciais");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("porta não permitida");
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("IP interno bloqueado");
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new Error("host interno bloqueado");
  return u;
}

interface PageFetch { finalUrl: string; status: number; text: string }

/** Baixa apenas texto/HTML (sem executar JS), com limite de tamanho, timeout e redirects revalidados. */
export async function safeFetchPage(raw: string, maxRedirects = 3, maxBytes = 400_000): Promise<PageFetch> {
  let url = validateExternalUrl(raw);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await undiciFetch(url.toString(), {
      dispatcher: agent,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "JobHunterBot/1.0 (verificação de vaga)", accept: "text/html,text/plain" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = validateExternalUrl(new URL(res.headers.get("location")!, url).toString());
      await res.body?.cancel();
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    let text = "";
    if (/text\/|html|xml/i.test(type) && res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.length;
      }
      await reader.cancel().catch(() => {});
      text = Buffer.concat(chunks).toString("utf8");
    } else await res.body?.cancel();
    return { finalUrl: url.toString(), status: res.status, text };
  }
  throw new Error("redirecionamentos demais");
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Sinais de golpe detectáveis por regras simples no texto (complementa a IA). */
export function scanTextSigns(job: Pick<Job, "title" | "description" | "url">): string[] {
  const t = `${job.title}\n${job.description}`;
  const signs: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/(pay|paga(r|mento)|taxa|fee|deposit|dep[óo]sito)[^.\n]{0,50}(training|treinamento|kit|equipment|equipamento|application|inscri[çc][ãa]o|processo seletivo|background check)/i, "Cobrança de valores para participar do processo/treinamento"],
    [/(bank (account|details)|dados banc[áa]rios|conta banc[áa]ria|credit card|cart[ãa]o de cr[ée]dito|\bssn\b|social security|\bcpf\b[^.\n]{0,30}(enviar|send)|send (a )?copy of (your )?(id|passport))/i, "Solicita dados bancários/documentos sensíveis"],
    [/(gift ?cards?|western union|moneygram|crypto(currency)? (payment|wallet)|bitcoin|usdt)/i, "Menção a pagamento por gift card/transferência/cripto"],
    [/(whats ?app|telegram|signal)[^.\n]{0,60}(contact|contato|entre em contato|apply|candidat|send)/i, "Processo seletivo conduzido por mensageiro (WhatsApp/Telegram)"],
    [/(earn|ganhe|ganhos?)\s+(up to\s+)?(\$|r\$|usd)\s?\d{3,}[^.\n]{0,25}(per day|por dia|a day|daily|diários?)/i, "Promessa salarial incomum (ganhos diários elevados)"],
    [/(no experience (needed|required)|sem experi[êe]ncia)[^.\n]{0,80}(\$|r\$)\s?\d{4,}/i, "Salário alto sem exigir experiência"],
    [/(hired immediately|contrata[çc][ãa]o imediata|no interview|sem entrevista)/i, "Contratação imediata/sem entrevista"],
  ];
  for (const [re, msg] of rules) if (re.test(t)) signs.push(msg);

  const links = t.match(/https?:\/\/[^\s)>"']+/gi) ?? [];
  for (const l of links) {
    try {
      const h = new URL(l).hostname;
      if (SHORTENERS.test(h)) { signs.push(`Link encurtado/mensageiro na descrição (${h})`); break; }
    } catch { /* ignora links malformados */ }
  }
  return [...new Set(signs)];
}

export interface VerifyDeps { fetchPage?: (url: string) => Promise<PageFetch> }

export async function verifyJob(job: Job, deps: VerifyDeps = {}): Promise<VerificationResult> {
  const fetchPage = deps.fetchPage ?? safeFetchPage;
  const result: VerificationResult = {
    status: "unverified", checkedUrl: job.url, evidence: [], warnings: [], missing: [], checkedAt: new Date().toISOString(),
  };

  let url: URL;
  try { url = validateExternalUrl(job.url); } catch (e) {
    result.status = "suspicious";
    result.warnings.push(`URL inválida ou bloqueada: ${(e as Error).message}`);
    return result;
  }
  if (url.protocol !== "https:") result.warnings.push("Link não usa HTTPS");
  if (SHORTENERS.test(url.hostname)) result.warnings.push("Link de candidatura é um encurtador/mensageiro");
  if (url.hostname.includes("xn--")) result.warnings.push("Domínio com punycode (possível homógrafo)");

  const trusted = TRUSTED_ATS.some((re) => re.test(url.hostname));
  const aggregator = AGGREGATORS.some((re) => re.test(url.hostname));
  const companySlug = norm(job.company).replace(/ /g, "");
  const hostMatches = companySlug.length >= 3 && norm(url.hostname).replace(/ /g, "").includes(companySlug);
  if (hostMatches) result.evidence.push("Domínio do link corresponde ao nome da empresa");

  if (NO_FETCH.some((re) => re.test(url.hostname))) {
    result.evidence.push(`Anúncio listado em ${url.hostname.replace(/^www\./, "")} (página não acessada por respeitar os termos do site)`);
    result.missing.push("Vaga não confirmada na página de carreiras da empresa");
    result.status = result.warnings.some((w) => /encurtador|punycode/.test(w)) ? "suspicious" : "unverified";
    return result;
  }

  let page: PageFetch | undefined;
  try {
    page = await fetchPage(job.url);
    result.finalUrl = page.finalUrl;
    result.httpStatus = page.status;
  } catch (e) {
    result.missing.push(`Não foi possível acessar a página da vaga (${(e as Error).message})`);
  }

  let titleFound = false;
  if (page) {
    if (page.status >= 200 && page.status < 300) {
      result.evidence.push("Página da vaga acessível");
      const body = norm(htmlToText(page.text));
      const title = norm(job.title);
      titleFound = title.length > 0 && body.includes(title);
      if (titleFound) result.evidence.push("Título da vaga encontrado na página");
      else result.missing.push("Título da vaga não encontrado na página (pode exigir JavaScript)");
    } else {
      result.warnings.push(`Página da vaga retornou HTTP ${page.status}`);
    }
  }

  const finalHost = page ? new URL(page.finalUrl).hostname : url.hostname;
  if (page && finalHost !== url.hostname && !TRUSTED_ATS.some((re) => re.test(finalHost)) && trusted) {
    result.warnings.push(`Redirecionou para domínio diferente (${finalHost})`);
  }

  const ok = !!page && page.status >= 200 && page.status < 300;
  if (result.warnings.some((w) => /encurtador|punycode|Redirecionou/.test(w))) result.status = "suspicious";
  else if (trusted && ok && titleFound && ["greenhouse", "lever"].includes(job.source)) {
    result.status = "verified";
    result.evidence.push("Vaga publicada no ATS oficial da empresa monitorada");
  } else if ((trusted || aggregator) && ok) {
    result.status = "partially_verified";
    result.missing.push(aggregator ? "Vaga ainda não confirmada na página de carreiras da empresa" : "Confirmação completa no ATS indisponível");
  } else {
    result.status = "unverified";
    if (!trusted && !aggregator) result.missing.push("Domínio não é um ATS conhecido nem agregador confiável");
    if (!hostMatches) result.missing.push("Vaga não confirmada na página oficial da empresa");
  }
  return result;
}
