/** Sites que são listagens/agregadores: o link leva a uma página intermediária, não ao formulário da empresa. */
const AGGREGATORS: Array<[RegExp, string]> = [
  [/(^|\.)adzuna\./i, "Adzuna"],
  [/(^|\.)jooble\./i, "Jooble"],
  [/(^|\.)remotive\./i, "Remotive"],
  [/(^|\.)remoteok\./i, "RemoteOK"],
  [/(^|\.)jobicy\./i, "Jobicy"],
  [/(^|\.)himalayas\./i, "Himalayas"],
  [/(^|\.)linkedin\./i, "LinkedIn"],
  [/(^|\.)indeed\./i, "Indeed"],
  [/(^|\.)glassdoor\./i, "Glassdoor"],
];

export function describeLink(url: string): { direct: boolean; label: string } {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const agg = AGGREGATORS.find(([re]) => re.test(host));
    if (agg) return { direct: false, label: `via ${agg[1]} (abre a página da vaga; use o botão de candidatura lá)` };
    return { direct: true, label: `direto (${host})` };
  } catch {
    return { direct: false, label: "link inválido" };
  }
}
