# JobHunter Bot

Bot pessoal de Telegram que busca vagas de tecnologia e **freelas** em APIs públicas (Remotive, RemoteOK, Jobicy, Himalayas, Greenhouse, Lever) e, opcionalmente, páginas públicas de vagas do LinkedIn via ZenRows. Filtra pelo seu perfil, classifica compatibilidade e sinais de golpe com IA (OpenRouter) e notifica só você — sem duplicatas.

**Não** faz candidaturas nem envia currículo. A coleta do LinkedIn só é ativada com uma chave própria do ZenRows.

## Requisitos
Node.js 20+ (testado no 24), Docker, um bot criado no [@BotFather](https://t.me/BotFather) e (opcional, mas recomendado) uma chave do [OpenRouter](https://openrouter.ai/keys).

## Instalação e execução
```bash
npm install
cp .env.example .env          # preencha os valores (veja abaixo)
docker compose up -d          # PostgreSQL em localhost:5434
npx prisma migrate deploy     # cria as tabelas
npm run build && npm start    # ou: npm run dev
```
Testes (usam mocks, não gastam créditos): `npm test`. Checagem de tipos: `npm run typecheck`.

## Variáveis de ambiente
| Variável | Obrigatória | Descrição |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sim | Token do @BotFather |
| `TELEGRAM_USER_ID` | sim | **Seu** ID numérico (use o @userinfobot). Não é o ID do bot (o número antes do `:` no token). Só este usuário acessa o bot; os demais são ignorados |
| `OPENROUTER_API_KEY` | não* | Chave `sk-or-...`. Sem ela as vagas chegam sem análise de IA |
| `OPENROUTER_MODEL` | não | Padrão `openrouter/free`. Se o modelo não respeitar JSON, troque por outro |
| `DATABASE_URL` | sim | Já aponta para o Docker Compose (porta 5434) |
| `SEARCH_INTERVAL_MINUTES` | não | Padrão 30 (divisor de 60 ou múltiplo de 60) |
| `RUN_ON_START` | não | Padrão `true`: busca ao iniciar |
| `MAX_NOTIFICATIONS_PER_RUN` | não | Padrão 10; o excedente fica para a próxima execução |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | não | Ativam a fonte Adzuna (Brasil) |
| `JOOBLE_API_KEY` | não | Ativa a fonte Jooble (Brasil) |
| `JSEARCH_RAPIDAPI_KEY` | não | Ativa LinkedIn/Indeed/Glassdoor via JSearch |
| `ZENROWS_API_KEY` | não | Ativa a coleta das páginas públicas de vagas do LinkedIn pelo ZenRows Fetch API (`mode=auto`, proxy BR) |
| `PROFILE_PATH` | não | Padrão `config/profile.json` |

## Configurando filtros e perfil
Tudo fica em `config/profile.json` (reinicie o bot após editar; uma cópia é gravada na tabela `SearchProfile`):
- `candidate.summary` / `candidate.skills`: **edite com a sua experiência real**. A IA só considera o que estiver aqui e descarta competências que não estejam na lista.
- `filters`: remoto, elegibilidade Brasil, PJ/CLT, salário mínimo (R$), senioridade, janela de publicação (`preferredAgeHours` = 24h para destaque, `maxAgeHours` = 72h limite), score mínimo e palavras-chave de cargo.
- `currencyToBRL`: câmbio aproximado fixo usado só para comparar salário; ajuste quando quiser.
- `sources.greenhouse.companies` / `sources.lever.companies`: empresas monitoradas (o *board token* é o final da URL de carreiras, ex.: `boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`). Essas APIs não têm busca global.
- `sources.zenrowsLinkedin`: consultas, local, janela de publicação, intervalo de cache e limites de cards/detalhes. Cada detalhe consome uma requisição adicional do ZenRows; reduza `maxDetailsPerQuery` para economizar créditos ou use `0` para coletar somente os cards.

Dados ausentes (salário, contrato, data, modalidade, senioridade) **não descartam** a vaga: ela é enviada com a lista “Não verificado”. Só há descarte quando existe evidência clara de incompatibilidade.

## Comandos
`/start`, `/buscar` (vagas + freelas), `/freelas` (só freelas), `/filtros`, `/status`, `/ajuda`. Cada vaga traz botões **Ver vaga / Salvar / Descartar / Reanalisar**.

## Filtros atuais (config/profile.json)
- **Vagas (CLT/PJ):** 100% remotas e elegíveis ao Brasil; salário **acima de R$ 3.000** (sem salário informado não descarta); júnior ou pleno; cargo de tecnologia com ao menos uma stack de interesse.
- **Concorrência:** se a fonte informar nº de candidatos, aceita até `maxApplicants` (30); se não informar, só aceita vagas "muito recentes" (`veryRecentHours`, 120h). Teto absoluto de `maxAgeHours` (168h).
- **Compatibilidade com o currículo:** a IA recebe o resumo e as competências do seu CV (`candidate`) e vagas abaixo de `minMatchScore` (50) são descartadas silenciosamente (ficam registradas, não são reenviadas).
- **Confiabilidade:** vagas com link suspeito (encurtador, IP interno, punycode, redirecionamento estranho), risco alto, sinais textuais de golpe ou recomendação "evitar" são descartadas (status `SKIPPED_RISK`).
- **Freelas:** detectados por tipo de contrato (freelance) ou por palavras de projeto (bot, automação, WordPress, landing page, scraper, n8n...). Regras próprias: sem exigência de salário/senioridade, mas remoto, elegível ao Brasil, escopo ligado ao seu CV/stack (`filters.freelance`) e mesma regra de recência.

## Campos da vaga e link de acesso
Toda mensagem traz **Empresa, Modalidade, Fonte, Publicação, Link e Salário** (quando a fonte não informa, aparece "não informado/não divulgado": nada é inventado). `filters.requiredFields` define o que é **obrigatório** (vaga sem o campo é descartada); padrão atual: `company`, `url`, `modality` e `publishedAt` (vaga sem eles não é exibida); o salário pode vir "não divulgado". Para relaxar, remova itens da lista.

O link mostra se é **direto** (ATS/site da empresa) ou **via agregador**. Adzuna/Jooble/Remotive/RemoteOK/Jobicy/Himalayas/LinkedIn levam a uma página intermediária; o bot **não** extrai o link final da empresa porque os termos do Adzuna (e dos demais) exigem que o acesso passe por eles. O JSearch já informa o link direto quando existe.

## LinkedIn
Com `ZENROWS_API_KEY`, o bot consulta a busca pública de vagas do LinkedIn por meio do [ZenRows Fetch API](https://docs.zenrows.com/fetch/api-reference), usando o modo adaptativo e saída geolocalizada no Brasil. A configuração padrão faz duas buscas a cada 6 horas, limita a 10 cards e até 6 páginas de detalhe por consulta, e guarda o resultado em cache. Ajuste esses números ao seu plano e use a integração de acordo com os termos aplicáveis.

Posts do feed continuam fora da coleta automática. Para analisá-los, **cole (ou encaminhe) o texto do post no chat do bot**; `/analisar` explica o fluxo.

## Fontes e limites das APIs
| Fonte | Observação |
|---|---|
| Remotive | Máx. ~4 requisições/dia (intervalo mínimo de 6h) e vagas com 24h de atraso |
| RemoteOK | Exige link de volta/atribuição (as mensagens apontam para a página deles) |
| Jobicy | Exige crédito e link original (feito) |
| Himalayas | Feed público; informa salário e restrições de país |
| Adzuna (opcional, chave) | Vagas no Brasil (empresas brasileiras, em português). Cadastro grátis em developer.adzuna.com. Salário "estimado" é ignorado. Link de candidatura passa pelo Adzuna (atribuição) |
| Jooble (opcional, chave grátis) | Vagas no Brasil. Chave solicitada em jooble.org/api/about. O `link` passa pelo Jooble (atribuição); salário vem como texto livre e só é usado se for interpretável |
| JSearch (opcional, chave RapidAPI) | Agrega vagas do LinkedIn, Indeed, Glassdoor etc. por API licenciada. Plano grátis ~200 req/mês: com 2 consultas a cada 12h gasta ~120/mês |
| ZenRows (opcional, chave) | Busca páginas públicas do LinkedIn com `mode=auto` e proxy BR. O cache padrão é de 6h; cada busca custa 1 requisição mais até `maxDetailsPerQuery` requisições de detalhe |
| Greenhouse / Lever | Apenas empresas listadas em `profile.json` |

Cada fonte tem `refreshMinutes`; entre execuções o bot usa um cache em `.cache/` para não exceder os limites. Workana/99Freelas/Gupy/Indeed/Glassdoor continuam sem coleta direta. O LinkedIn é a única plataforma protegida configurada e todo acesso passa pelo ZenRows quando a chave está presente.

## Arquitetura
```
src/
  collectors/   remotive, greenhouse, lever  -> modelo Job unificado
  services/     job-filter, job-analysis (OpenRouter + Zod), job-verification (URL/SSRF),
                job-review (cache + orquestração), notification, search (pipeline), normalize
  bot/          commands, callbacks, message (formatação HTML do Telegram)
  scheduler/    node-cron
  database/     Prisma client + JobStore
prisma/schema.prisma   Job, JobAnalysis, SearchProfile, Notification, SavedJob, SearchExecution
tests/                 filtros, normalização, análise/classificação, verificação, deduplicação
```
Deduplicação: `Job` tem `@@unique([source, externalId])` e `Notification.jobId` é único; a vaga só é marcada como notificada depois do envio bem-sucedido (se o Telegram falhar, ela é reenviada na próxima busca). Análises ficam em `JobAnalysis` e só são refeitas com o botão Reanalisar (ou se a tentativa anterior falhou).

## Segurança
- Acesso restrito a `TELEGRAM_USER_ID`; tokens nunca vão para logs (redação automática); `.env` está no `.gitignore`.
- Descrição da vaga é tratada como **dado não confiável** no prompt (delimitada, sanitizada, truncada); a saída do modelo é validada com Zod e as competências são cruzadas com o seu perfil.
- A IA nunca declara uma vaga “autêntica”: `authenticityStatus` é sempre `unverified`. A verificação externa (URL acessível, domínio, título na página, ATS oficial) é separada e só marca `verified` para vagas no Greenhouse/Lever das empresas monitoradas.
- A verificação de URLs só baixa texto (não executa JS), limita tamanho/redirects e bloqueia IPs internos no momento da conexão (anti-SSRF).
- Uma chamada por vez ao OpenRouter, com intervalo mínimo, timeout e retentativas controladas.

## Limitações conhecidas
- A Remotive atrasa a publicação de vagas em ~24h e limita requisições; a API pública devolve poucas vagas por vez. Respeite os termos de uso (não republique as vagas).
- Greenhouse/Lever só cobrem as empresas listadas; `first_published` do Greenhouse pode refletir republicações.
- Elegibilidade para o Brasil é inferida por texto do local/descrição (heurística em inglês/português); locais específicos fora do Brasil são descartados.
- Nenhuma das APIs públicas usadas informa o nº de candidatos; por isso a regra efetiva é "muito recente". O campo `applicants` já está no modelo para fontes futuras.
- Freelas de desenvolvimento são raros nesses feeds (no teste, 5 freelas no total e nenhuma de dev). Para mais volume seria preciso uma API com chave (ex.: Freelancer.com).
- Salário só é lido de campos estruturados (Lever) ou texto da Remotive; conversão de moeda usa câmbio fixo da configuração.
- A verificação “na página oficial da empresa” para vagas da Remotive ainda não existe (ficam `partially_verified` no máximo).
