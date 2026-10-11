/**
 * Núcleo da busca pública de oportunidades — sem nada de plataforma.
 *
 * Os adaptadores (`netlify/functions/buscar.mjs` e `api/buscar.mjs`) só traduzem
 * requisição e resposta; toda a regra mora aqui, para que Netlify e Vercel
 * nunca divirjam de comportamento.
 *
 * DOIS PORTAIS, POR UM MOTIVO
 *
 * A OLX tem volume de particulares, mas não entrega contato: medido em
 * produção, o detalhe do anúncio devolve `phoneHashes: []` e o vendedor apenas
 * como `nameHash`. O Chaves na Mão entrega nome e celular — e, o que importa
 * mais, marca `phones.public` quando o anunciante escolheu exibir o número.
 * Em compensação é dominado por imobiliárias: numa amostra de 15 anúncios,
 * 14 eram PJ.
 *
 * Consultar os dois resolve os dois defeitos: o Chaves na Mão traz os
 * contatáveis, a OLX completa o volume.
 *
 * REGRA DE CONTATO
 *
 * Telefone e nome só saem quando o anunciante é pessoa física E o portal
 * marcou o telefone como público. Nunca inferimos, nunca "desanonimizamos":
 * o que sai daqui é o que a pessoa publicou no portal, e nada além.
 */

export const ALVO = 10;

/**
 * A partir de quantos anúncios distintos no MESMO telefone o anunciante deixa
 * de ser um contato individual e vira carteira.
 *
 * O sinal não é o nome nem o cadastro: é o telefone repetido. Quem tem catorze
 * anúncios no mesmo número é operação, não dono. E vale mesmo quando o portal
 * declarou "PF": a frequência do telefone vence a autodeclaração, porque é o
 * que a captação já aprendeu — corretor autônomo se cadastra como pessoa
 * física. Medido do lado da captação; aqui a régua é a mesma.
 */
const LIMITE_CARTEIRA = Math.max(2, Number(process.env.JAZZ_LIMITE_CARTEIRA) || 4);
// Fixo (10 dígitos) repetido em dois anúncios já é operação: dono quase nunca
// anuncia dois imóveis pelo telefone da empresa. Medido em Taubaté: "Newcore"
// com o mesmo fixo em dois anúncios, ambos marcados como particular.
const ehCarteira = (o) =>
  o.telefone != null &&
  (o.anuncios_no_telefone ?? 1) >= (String(o.telefone).length === 10 ? 2 : LIMITE_CARTEIRA);

// Dias desde a publicação/atualização, quando o portal informa. Lead de dono
// recém-anunciado é mais quente: ainda não assinou com imobiliária.
function diasDesde(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((Date.now() - t) / 86400000);
  return d >= 0 && d < 3650 ? d : null;
}

// Mediana simples, para a régua de "abaixo do mercado".
function mediana(nums) {
  const v = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Quanto abaixo da mediana de preço/m² o anúncio precisa estar para ser
// "oportunidade". 15% é folga larga: não é ruído de digitação, é preço de quem
// quer vender rápido — o melhor alvo de captação e a melhor barganha de compra.
const DESCONTO_OPORTUNIDADE = 0.85;

/**
 * Código de acesso da ferramenta.
 *
 * Não é autenticação: é um portão compartilhado, para que a página não fique
 * aberta a qualquer um que ache a URL. Vale principalmente do lado do
 * SERVIDOR — sem a conferência aqui, bastaria chamar `/api/buscar` direto
 * para gastar o crédito da GeckoAPI, e o campo na tela não impediria nada.
 *
 * Sai de `JAZZ_CODIGO_ACESSO` quando a variável existir, para trocar o código
 * sem publicar de novo.
 */
const CODIGO_PADRAO = "jazzconecta2026";
const arrumaCodigo = (v) => String(v ?? "").trim().toLowerCase();
function codigoConfere(codigo) {
  return arrumaCodigo(codigo) === arrumaCodigo(process.env.JAZZ_CODIGO_ACESSO || CODIGO_PADRAO);
}
const GECKO_URL = "https://api.geckoapi.com.br/v1/extract";

// Cada busca gasta um crédito POR PORTAL. Os limites contam chamadas, não
// buscas, para que somar portais não fure o orçamento sem ninguém perceber.
const JANELA_MS = 60_000;
// O teto conta CHAMADAS, e cada busca gasta uma por portal — hoje quatro.
// Quarenta mantém as dez buscas por minuto de antes, que é o que separa quem
// está explorando filtros de quem está abusando. Somar portal sem mexer aqui
// encolhe o número de buscas sem ninguém perceber.
const MAX_CHAMADAS_POR_JANELA = 40;

/**
 * Teto de consultas por IP em 24 horas.
 *
 * RESSALVA HONESTA: esta contagem vive na memória do isolate. Em serverless
 * não há um único processo — requisições caem em isolates diferentes, e cada
 * um começa com a memória zerada. Na prática isto segura quem fica repetindo
 * a busca (o isolate quente é reaproveitado), mas NÃO é um muro. Um muro de
 * verdade precisa de armazenamento compartilhado; o orçamento diário global,
 * esse sim, é o que garante que a conta não estoure.
 *
 * O mesmo erro já apareceu aqui no rodízio de páginas: o contador de módulo
 * nascia zerado a cada requisição e a busca devolvia sempre a mesma lista.
 */
const MAX_CONSULTAS_POR_IP = 10;
const DIA_MS = 24 * 60 * 60 * 1000;
const porIp = new Map();

export function podeConsultar(ip) {
  const chave = String(ip ?? "").trim();
  // Sem IP não dá para limitar por IP; o teto global continua valendo.
  if (!chave) return null;

  const agora = Date.now();
  // Limpeza preguiçosa: sem isto o Map cresceria enquanto o isolate viver.
  if (porIp.size > 5000) {
    for (const [k, v] of porIp) if (agora - v.inicio > DIA_MS) porIp.delete(k);
  }

  const reg = porIp.get(chave);
  if (!reg || agora - reg.inicio > DIA_MS) {
    porIp.set(chave, { inicio: agora, n: 1 });
    return null;
  }
  if (reg.n >= MAX_CONSULTAS_POR_IP) return "limite_diario_do_visitante";
  reg.n += 1;
  return null;
}

let janela = { inicio: Date.now(), n: 0 };
let dia = { data: hojeIso(), n: 0 };

function hojeIso() {
  return new Date().toISOString().slice(0, 10);
}

function tetoDia() {
  const v = Number(process.env.GECKO_MAX_CHAMADAS_DIA);
  return Number.isFinite(v) && v > 0 ? v : 200;
}

/** Reserva `quantas` chamadas. Devolve o motivo da recusa, ou null se liberou. */
export function podeChamar(quantas = 1) {
  const agora = Date.now();
  if (agora - janela.inicio > JANELA_MS) janela = { inicio: agora, n: 0 };
  if (dia.data !== hojeIso()) dia = { data: hojeIso(), n: 0 };
  if (dia.n + quantas > tetoDia()) return "orcamento_diario_esgotado";
  if (janela.n + quantas > MAX_CHAMADAS_POR_JANELA) return "muitas_buscas_agora";
  janela.n += quantas;
  dia.n += quantas;
  return null;
}

/** Só para os testes: zera os contadores entre cenários. */
export function reiniciarLimites() {
  porIp.clear();
  janela = { inicio: Date.now(), n: 0 };
  dia = { data: hojeIso(), n: 0 };
}

/**
 * Diz POR QUE a chave não foi encontrada, sem nunca revelar valor nenhum —
 * apenas se existe alguma variável com "GECKO" no nome, e se a que importa
 * está vazia.
 *
 * Existe porque configurar isto no painel do host tem três erros que produzem
 * exatamente o mesmo sintoma: não criar a variável, criar com o nome errado
 * (colar a chave no campo "Key", por exemplo) e criar com valor vazio. Sem
 * distinguir os três, a depuração vira tentativa e erro às cegas, com um
 * deploy de espera a cada palpite.
 */
function diagnosticoChave() {
  const comGecko = Object.keys(process.env).filter((n) => /GECKO/i.test(n));
  if (comGecko.length === 0) {
    return "nenhuma variável de ambiente com GECKO no nome — ela não foi criada, ou o nome saiu diferente";
  }
  if (!comGecko.includes("GECKO_API_KEY")) {
    return `há ${comGecko.length} variável(is) com GECKO no nome, mas nenhuma se chama exatamente GECKO_API_KEY`;
  }
  return "GECKO_API_KEY existe mas chegou vazia na função — confira o valor e o escopo (precisa incluir Functions)";
}

function normalizar(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** "São José dos Campos" → "sao-jose-dos-campos" */
function slug(v) {
  return normalizar(v).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function inteiro(valor) {
  const n = parseInt(String(valor ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function naoNegativo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Quantas páginas entram no rodízio. Três é o equilíbrio: fundo grande o
// bastante para a lista mudar de verdade, raso o bastante para as páginas
// ainda serem relevantes para a busca.
const PAGINAS_NO_RODIZIO = 3;

// Quantas páginas do Chaves na Mão puxar por busca. Cada uma custa um crédito
// e rende cerca de um proprietário contatável; uma só deixava a lista com um
// único contato direto, o que é pouco para a promessa da página.
const PAGINAS_CHAVES_NA_MAO = 2;

// Catálogo de portais. Cada plano vira UMA chamada à GeckoAPI; Chaves na Mão
// gera duas (duas páginas). As funções de URL e normalização são declarações
// içadas, então podem ser referenciadas aqui mesmo estando definidas abaixo.
//
// Por que nomeado e não posicional: o código antigo fatiava `payloads` por
// índice (`slice(1, 1+N)`, `payloads[length-1]`), e qualquer portal novo no
// meio desalinhava tudo calado. Agрupar por nome elimina essa classe de bug.
//
// VivaReal e Chaves na Mão vão pela busca ESTRUTURADA da Gecko com
// `directOwner: true`: o próprio portal só devolve anúncio de proprietário
// direto. Medido em São José dos Campos (10/10/2026): VivaReal com o filtro
// trouxe 27 anúncios, 26 com WhatsApp, 24 de dono de verdade. Pela URL, sem o
// filtro, a mesma página vinha quase toda de imobiliária — o falso positivo
// que a Jazz reclamou na busca de Taubaté.
const PORTAIS = {
  "OLX":           { target: "olx.com.br",         paginas: 1,                     url: (a) => urlOlx(a.bairro, a.cidade, a.finalidade, a.tipo, a.pg),  normaliza: normalizarOlx },
  "Chaves na Mão": { target: "chavesnamao.com.br", paginas: PAGINAS_CHAVES_NA_MAO, url: (a, k) => corpoDonoDireto(a, a.pg + k), normaliza: normalizarChavesNaMao, direto: true },
  "VivaReal":      { target: "vivareal.com.br",    paginas: 1,                     url: (a) => corpoDonoDireto(a, a.pg),        normaliza: normalizarVivaReal, direto: true, completaCidade: true },
  "ZAP":           { target: "zapimoveis.com.br",  paginas: 1,                     url: (a) => urlZap(a.cidade, a.uf, a.finalidade, a.pg),             normaliza: normalizarZap },
};

/** Busca estruturada só de proprietário direto (VivaReal e Chaves na Mão). */
const TIPO_GECKO = { Casa: ["house", "two_story_house", "condominium"], Apartamento: ["apartment", "penthouse", "kitnet", "flat"],
  Terreno: ["land"], Comercial: ["commercial_room", "commercial_point", "warehouse"] };
const oumais = (n) => Array.from({ length: Math.max(1, 5 - Math.min(4, n)) }, (_, i) => Math.min(4, n) + i);
function corpoDonoDireto(a, pagina) {
  const corpo = {
    city: a.cidade, state: a.uf || "SP",
    businessType: a.finalidade === "Locação" ? "rent" : "sale",
    directOwner: true, page: Math.max(1, pagina),
  };
  if (a.bairro) corpo.neighborhood = a.bairro.replace(/[,|]/g, " ").slice(0, 120);
  if (TIPO_GECKO[a.tipo]) corpo.propertyTypes = TIPO_GECKO[a.tipo];
  // Filtros vão para o portal (a Gecko repassa: priceMin/priceMax/usableAreasMin/
  // bedrooms/parkingSpots, conferido em 11/10/2026). Antes a página pedia a cidade
  // inteira e filtrava depois: em São José dos Campos, de 29 donos só 2 cabiam
  // no filtro. Mínimo de quartos/vagas vira a lista "N ou mais" (o portal vai até 4+).
  if (a.precoMin > 0) corpo.priceMin = Math.round(a.precoMin);
  if (a.precoMax > 0) corpo.priceMax = Math.round(a.precoMax);
  if (a.areaMin > 0) corpo.areaMin = Math.round(a.areaMin);
  if (a.quartosMin > 0) corpo.bedrooms = oumais(a.quartosMin);
  if (a.vagasMin > 0) corpo.parkingSpots = oumais(a.vagasMin);
  return corpo;
}

// Quais portais consultar. Liga/desliga por custo sem publicar de novo — cada
// portal a mais é ~1 crédito por busca. Default sem ZAP: ele sobrepõe o
// VivaReal (mesmo grupo) e precisa de uma validação ao vivo antes.
//
// Chaves na Mão saiu do padrão em 11/10/2026. Medido em Taubaté e São José dos
// Campos: a Gecko aceita `directOwner: true`, mas a URL que ela monta para o
// portal sai sem o filtro (apiUrl só com `tve:[0]`), e as duas páginas vinham
// com 14 de 14 anunciantes PJ, 11 com CRECI. Eram 2 créditos por busca para
// trazer só imobiliária. Volta quando a Gecko repassar o filtro (JAZZ_PORTAIS).
const PORTAIS_PADRAO = "OLX,VivaReal";
function portaisAtivos() {
  const nomes = String(process.env.JAZZ_PORTAIS ?? PORTAIS_PADRAO)
    .split(",").map((n) => n.trim()).filter((n) => PORTAIS[n]);
  return nomes.length ? nomes : ["OLX", "VivaReal"];
}
function montarPlanos(a) {
  const planos = [];
  for (const nome of portaisAtivos()) {
    const cfg = PORTAIS[nome];
    for (let k = 0; k < cfg.paginas; k++) {
      planos.push({ portal: nome, target: cfg.target, url: cfg.url(a, k), normaliza: cfg.normaliza, direto: !!cfg.direto });
    }
    // Bairro pedido costuma ter poucos donos com telefone (Taubaté/Centro:
    // seis). Uma página a mais da cidade inteira completa a lista com dono
    // que dá para chamar; o bairro continua na frente pela ordenação.
    if (cfg.completaCidade && a.bairro) {
      planos.push({ portal: nome, target: cfg.target, url: cfg.url({ ...a, bairro: "" }, 0), normaliza: cfg.normaliza, direto: !!cfg.direto });
    }
  }
  return planos;
}

/**
 * Escolhe a página a pedir.
 *
 * O rodízio é responsabilidade do CLIENTE, que manda `pagina` incrementando a
 * cada repetição da mesma busca. A primeira versão disto contava no servidor,
 * num Map de módulo — e não funcionava: cada requisição em serverless pode cair
 * num isolate novo, então o contador nascia zerado e pedia sempre a página 1.
 * Duas buscas iguais voltavam com os mesmos dez anúncios, exatamente o que o
 * rodízio existia para evitar.
 *
 * Sem `pagina` (chamada direta à API, sem passar pela página), sorteia — é
 * melhor variar por acaso do que repetir com certeza.
 */
function paginaDaBusca(pedida) {
  const n = Number(pedida);
  if (Number.isFinite(n) && n >= 1) return ((Math.floor(n) - 1) % PAGINAS_NO_RODIZIO) + 1;
  return Math.floor(Math.random() * PAGINAS_NO_RODIZIO) + 1;
}

/**
 * Casa o tipo pedido com a categoria que o portal devolve.
 *
 * Os padrões seguem os nomes REAIS medidos na OLX — "Comércio e indústria" e
 * "Terrenos, sítios e fazendas" — e não os nomes que a gente imagina. A versão
 * anterior procurava "comercial" e nunca casava com "Comércio e indústria":
 * o filtro devolvia lista vazia mesmo com anúncios na mão.
 *
 * A comparação é feita sobre o texto sem acento, senão "Comércio" escaparia de
 * /comercio/ e o bug voltaria pela porta dos fundos.
 */
const TIPOS = {
  Casa: /casa|sobrado/,
  Apartamento: /apart|apto|kitnet|flat|cobertura/,
  Terreno: /terreno|sitio|fazenda|chacara|lote/,
  Comercial: /comercio|industria|comercial|sala|loja|galp|predio|ponto/,
};

function casaComTipo(tipo, categoria) {
  if (!tipo) return true;
  // Portal que não classificou o anúncio não é motivo para escondê-lo: o
  // pedido é por semelhança, e um imóvel sem categoria pode muito bem ser o
  // que a pessoa procura. Só descarta quem foi classificado como outra coisa.
  const c = normalizar(categoria);
  if (!c) return true;
  return TIPOS[tipo].test(c);
}

/** Uma chamada à Gecko. Devolve o payload, ou null se o portal não respondeu. */
/**
 * Uma chamada à GeckoAPI, com UMA segunda tentativa.
 *
 * Medido: numa bateria de dez buscas seguidas, a chamada da OLX voltou vazia
 * em duas delas e a página devolveu lista vazia sem explicar nada. A falha era
 * momentânea — a mesma busca repetida logo depois funcionava. Uma segunda
 * tentativa custa um crédito só quando a primeira falhou, e é o que separa
 * "o portal está fora" de "deu um soluço agora".
 *
 * Erro 4xx não é soluço: é pedido malformado, e repetir gasta crédito à toa.
 * Só repetimos falha de rede e erro do servidor.
 */
/**
 * Prazo de cada chamada a um portal, e prazo total gasto com ele.
 *
 * Sem isto o `allSettled` lá embaixo NÃO cumpria o que o comentário dele
 * promete. `fetch` do Node não tem prazo padrão, e `allSettled` espera todas:
 * um portal pendurado segurava a busca inteira, e como a função tem limite de
 * execução no host, o resultado era perder também os outros três portais —
 * quatro créditos gastos para devolver erro de plataforma.
 *
 * Não é hipótese. Medido em 04/09, chamando a GeckoAPI direto:
 *   HTTP 504 · UPSTREAM_TIMEOUT · "Extraction timed out while waiting for
 *   upstream response"
 * 504 é 5xx, então a segunda tentativa entrava e esperava outro prazo cheio.
 *
 * Agora cada tentativa tem prazo próprio e as duas juntas têm um teto. Estourar
 * vira `null`, que o resto do código já trata como "portal não respondeu" — a
 * página sai com os portais que responderam, em vez de não sair.
 *
 * Os dois valores saem do ambiente para poderem ser ajustados sem publicar de
 * novo, e para o teste poder usar prazos curtos.
 */
const limiteDaChamada = () => Number(process.env.JAZZ_LIMITE_CHAMADA_MS) || 12_000;
const limiteDoPortal = () => Number(process.env.JAZZ_LIMITE_PORTAL_MS) || 20_000;

/**
 * Guarda a resposta crua de cada URL de portal.
 *
 * Onde ele ganha, medido e não suposto: a mesma URL de portal pedida duas
 * vezes. O caso que mais aparece é VISITANTES DIFERENTES buscando a mesma
 * cidade — cada navegador começa o rodízio na página 1, então a segunda pessoa
 * pede exatamente as URLs que a primeira já pagou. Numa página pública
 * divulgada para uma cidade, isso é a maioria das buscas.
 *
 * Onde ele NÃO ganha, e é importante dizer: o mesmo visitante repetindo a
 * busca. O rodízio de páginas existe justamente para variar o resultado, então
 * ele muda a URL de propósito a cada envio — inclusive quando só o preço mudou,
 * porque a assinatura do rodízio é cidade|bairro|finalidade. Cache e rodízio
 * puxam para lados opostos aí, e quem manda é o rodízio.
 *
 * RESSALVA HONESTA, a mesma do contador por IP: isto vive na memória do
 * isolate. Em serverless não há um processo só, então o acerto vale para
 * requisições que caiam no mesmo isolate — o caso comum de quem mexe no filtro
 * e busca de novo em seguida. Nunca é garantia, e por isso nada aqui depende
 * dele para estar correto: cache vazio devolve o comportamento de antes.
 *
 * Só entra resposta boa. Falha não vira cache, senão um 504 passageiro
 * congelaria o portal fora do ar pelos dez minutos seguintes.
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 12;
const cachePortal = new Map();

export function reiniciarCache() {
  cachePortal.clear();
}

function doCache(url) {
  const item = cachePortal.get(url);
  if (!item) return null;
  if (Date.now() - item.em > CACHE_TTL_MS) {
    cachePortal.delete(url);
    return null;
  }
  return item.payload;
}

function guardaNoCache(url, payload) {
  // Map preserva ordem de inserção: a chave mais antiga é a primeira.
  if (cachePortal.size >= CACHE_MAX) {
    cachePortal.delete(cachePortal.keys().next().value);
  }
  cachePortal.set(url, { payload, em: Date.now() });
}

/**
 * Transporte alternativo até a Gecko. No Netlify a função chama a Gecko
 * direto com a chave; no GitHub Pages a busca roda no navegador e a chamada
 * passa pelo banco (RPC oportunidades_pedir/resposta), que guarda a chave.
 * Recebe o corpo SEM target/type e o alvo; devolve o payload ou null.
 */
let transporte = null;
export function definirTransporte(fn) {
  transporte = typeof fn === "function" ? fn : null;
}

async function gecko(chave, url, target) {
  // `url` é a URL do portal OU o corpo da busca estruturada.
  const chaveCache = typeof url === "string" ? url : `${target}:${JSON.stringify(url)}`;
  const guardado = doCache(chaveCache);
  if (guardado) return guardado;
  if (transporte) {
    const payload = await transporte(typeof url === "string" ? { url } : url, target).catch(() => null);
    if (payload) guardaNoCache(chaveCache, payload);
    return payload;
  }

  const fim = Date.now() + limiteDoPortal();
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const restante = Math.min(limiteDaChamada(), fim - Date.now());
    if (restante <= 0) break;
    const alarme = new AbortController();
    const relogio = setTimeout(() => alarme.abort(), restante);
    try {
      const r = await fetch(GECKO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${chave}` },
        // O alvo é o domínio completo e o tipo é "plp" (página de listagem).
        // "olx"/"search" devolvem 400 INVALID_PAYLOAD — foi esse detalhe que
        // manteve a prospecção externa em zero por semanas.
        body: JSON.stringify(typeof url === "string" ? { url, target, type: "plp" } : { ...url, target, type: "plp" }),
        signal: alarme.signal,
      });
      if (r.ok) {
        const payload = await r.json();
        guardaNoCache(chaveCache, payload);
        return payload;
      }
      // Nossa culpa: repetir daria o mesmo 4xx.
      if (r.status >= 400 && r.status < 500) return null;
    } catch {
      // Rede caiu ou o prazo estourou; vale tentar de novo se sobrar tempo.
    } finally {
      clearTimeout(relogio);
    }
    if (tentativa === 0 && fim - Date.now() > 350) {
      await new Promise((ok) => setTimeout(ok, 350));
    }
  }
  return null;
}

// =================== OLX ===================

/**
 * Monta a busca na OLX.
 *
 * O caminho depende do TIPO, não só da finalidade, e isso era o bug: as
 * seções /imoveis/venda e /imoveis/aluguel são residenciais — devolvem só
 * Apartamentos e Casas. Pedir terreno ou imóvel comercial por ali e depois
 * filtrar por categoria nunca podia dar certo, porque a categoria procurada
 * jamais chegava. Medido: /imoveis/venda devolve duas categorias; a raiz
 * /imoveis devolve seis, incluindo terrenos e comércio.
 */
function urlOlx(bairro, cidade, finalidade, tipo, pagina) {
  const q = encodeURIComponent([bairro, cidade].filter((p) => p && p.trim()).join(" "));
  const secao =
    // Seção dedicada: 50 de 50 anúncios são comerciais.
    tipo === "Comercial" ? "imoveis/comercio-e-industria"
    // A raiz mistura tudo, mas é o único lugar onde terreno aparece; o filtro
    // de categoria peneira depois (10 de 50 na medição).
    : tipo === "Terreno" ? "imoveis"
    : `imoveis/${finalidade === "Locação" ? "aluguel" : "venda"}`;
  const base = `https://www.olx.com.br/${secao}?q=${q}&f=p&sf=1`;
  return pagina > 1 ? `${base}&o=${pagina}` : base;
}

function propriedadeOlx(item, nome) {
  return (item.properties ?? []).find((p) => p?.name === nome)?.value ?? null;
}

function normalizarOlx(payload) {
  return (payload?.data?.items ?? [])
    .map((i) => {
      const loc = i?.location ?? {};
      return {
        portal: "OLX",
        url: String(i?.url ?? ""),
        titulo: String(i?.title ?? "Anúncio de particular"),
        preco: Number(i?.price) || null,
        preco_texto: i?.priceDisplay ?? null,
        bairro: String(loc.neighborhood ?? "").trim() || null,
        cidade: String(loc.city ?? "").trim() || null,
        uf: String(loc.state ?? "").trim() || null,
        categoria: i?.category ?? null,
        quartos: inteiro(propriedadeOlx(i, "rooms")),
        area_m2: inteiro(propriedadeOlx(i, "size")),
        vagas: inteiro(propriedadeOlx(i, "garage_spaces")),
        banheiros: inteiro(propriedadeOlx(i, "bathrooms")),
        // Custo mensal pesa tanto quanto o preço na decisão de quem compra
        // apartamento no Brasil, e os dois portais já entregam.
        condominio: inteiro(propriedadeOlx(i, "condominio")),
        iptu: inteiro(propriedadeOlx(i, "iptu")),
        foto: i?.images?.[0]?.webpUrl ?? i?.images?.[0]?.url ?? null,
        publicado_em: i?.listedAt ?? null,
        // A OLX não expõe contato; medido, não suposto.
        anunciante: null,
        telefone: null,
        // `professionalAd` é o sinal autoritativo da OLX para imobiliária.
        // Antes ele DESCARTAVA o anúncio, e era a maior causa de lista curta:
        // numa busca com cinquenta anúncios lidos sobravam sete. Agora ele só
        // classifica, e a ordenação decide a posição.
        quem: i?.professionalAd === true ? "Imobiliária" : "Proprietário",
      };
    });
}

// =================== Chaves na Mão ===================

function urlChavesNaMao(cidade, uf, finalidade, pagina) {
  const caminho = finalidade === "Locação" ? "imoveis-para-alugar" : "imoveis-a-venda";
  const local = `${slug(uf) || "sp"}-${slug(cidade)}`;
  return `https://www.chavesnamao.com.br/${caminho}/${local}/?pg=${pagina}`;
}

/**
 * Extrai o contato SEMPRE que o portal marcou o telefone como público —
 * proprietário, corretor ou imobiliária.
 *
 * Antes só passava pessoa física sem CRECI, e o resultado era uma página de
 * anúncios sem telefone nenhum: o portal que tem contato é dominado por
 * imobiliária, então o filtro estrito derrubava quase tudo. Excluir deixou de
 * ser a regra; ORDENAR virou. Quem é proprietário aparece primeiro e o cartão
 * diz com quem se vai falar, que é a informação que o filtro escondia.
 *
 * A linha que continua de pé: `phones.public === true`. Só sai daqui o número
 * que a própria pessoa mandou o portal exibir. Nada é inferido, nada é
 * descoberto por fora.
 */
function contatoPublicado(anunciante) {
  if (!anunciante) return null;
  const fones = anunciante.phones ?? {};
  if (fones.public !== true) return null;
  const digitos = digitosDoTelefone(fones.cellphone ?? fones.commercial ?? fones.landline);
  if (!digitos) return null;

  const ehPessoa = anunciante.type === "PF";
  const temCreci = !!String(anunciante.creci ?? "").trim();
  return {
    nome: String(anunciante.name ?? "").trim() || null,
    telefone: digitos,
    // Ligar para um proprietário e ligar para uma imobiliária não são a mesma
    // conversa. O cartão mostra qual das duas é.
    quem: ehPessoa && !temCreci ? "Proprietário" : ehPessoa ? "Corretor" : "Imobiliária",
  };
}

/**
 * Normaliza um telefone brasileiro para os dígitos que o WhatsApp aceita.
 *
 * Alguns portais gravam com o código do país e outros sem. Deixar o 55 grudado
 * geraria um link de WhatsApp com 55 duplicado, que abre a conversa errada.
 */
function digitosDoTelefone(bruto) {
  let d = String(bruto ?? "").replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  // Celular cadastrado no formato antigo, sem o nono dígito: 10 dígitos com o
  // número começando em 6-9 é celular (fixo começa em 2-5). Sem o 9 o link do
  // WhatsApp não abre. Medido em Jacareí (11/10/2026): "(12) 9913-5572".
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  // 10 dígitos (fixo com DDD) ou 11 (celular). Fora disso é lixo.
  return d.length === 10 || d.length === 11 ? d : null;
}

/**
 * Contato do VivaReal.
 *
 * Precisa de regra própria porque o portal NÃO marca telefone como público ou
 * privado: os campos `phoneNumbers` e `whatsappNumber` vêm na própria listagem,
 * que é a mesma página aberta que qualquer pessoa vê sem login. Continua
 * valendo o princípio dos outros portais — só sai daqui o que o portal já
 * publica — mas a checagem tem de olhar para o que existe aqui, e não para uma
 * bandeira que este portal não tem.
 *
 * A forma dos campos foi medida, não suposta: veio do próprio diagnóstico da
 * busca, que passou a mostrar as chaves do anunciante quando nenhum telefone
 * saía.
 */
function contatoVivaReal(anunciante, direto = false) {
  if (!anunciante) return null;
  const lista = anunciante.phoneNumbers;
  const bruto =
    anunciante.whatsappNumber ??
    (Array.isArray(lista) ? lista.find(Boolean) : lista);
  const telefone = digitosDoTelefone(bruto);
  if (!telefone) return null;
  // `license` é o CRECI, e sozinho ele erra: numa página de trinta anúncios de
  // São José dos Campos, nove anunciantes vinham sem licença e TODOS os nove
  // eram empresa — "Alkova Imoveis", "Grupo Kaza Parque 10", "Bom Negocio
  // Atividades De Intermediação". Chamar isso de particular seria escrever
  // mentira no cartão.
  //
  // `tier` é o plano de anunciante (standard, gold, platinum, diamond) e não
  // existe para quem não paga: os trinta tinham um. Ele fecha o buraco que o
  // CRECI deixava. Nessa mesma medição o VivaReal não trouxe um único
  // particular — é portal de imobiliária, e o cartão passa a dizer isso.
  const profissional =
    !!String(anunciante.license ?? "").trim() || !!String(anunciante.tier ?? "").trim();
  return {
    nome: String(anunciante.name ?? "").trim() || null,
    telefone,
    // Pelo filtro de proprietário direto, quem não tem CRECI nem plano pago é
    // o dono. Fora dele, o VivaReal é portal de imobiliária e o cartão diz
    // só "Anunciante".
    quem: profissional ? "Imobiliária" : direto ? "Proprietário" : "Anunciante",
  };
}

/**
 * Foto do VivaReal na busca estruturada: vem em `media`, com o tamanho como
 * molde ({action}/{width}x{height}) que o próprio portal preenche no site.
 */
function fotoDaMidia(media) {
  const m = Array.isArray(media) ? media.find((x) => x?.type === "IMAGE" && x?.url) : null;
  return m ? String(m.url).replace("{action}", "crop").replace("{width}x{height}", "614x297") : null;
}

// =================== Quem é, de verdade ===================

/**
 * Nome de anunciante que é empresa ou profissional, mesmo quando o portal o
 * colocou no filtro de dono. Medido na busca de Taubaté (10/10/2026): "Intensa
 * Imóveis", "Imóveis Villa Branca", "Unica Imoveis Taubate", "Newcore",
 * "Bom Negocio Atividades De Internet Ltda" (a empresa da própria OLX).
 */
const NOME_DE_EMPRESA = new RegExp(
  "\\b(im[oó]veis|imobili[aá]ri[ao]|imob|corretor[a]?|corretagem|consultori[ao]|consultor[a]?|neg[oó]cios|" +
  "empreendimentos?|incorporador[a]?|construtor[a]?|realty|real\\s*estate|ltda|eireli|epp|s\\.?\\s?a\\.?|" +
  "grupo|holding|investimentos?|patrimonial|participa[cç][oõ]es|assessoria|administradora|internet|" +
  "atividades|servi[cç]os|com[eé]rcio|loteadora|urbanismo|newcore|house|home|prime|premium)\\b", "i");

export function nomeDeEmpresa(nome) {
  return !!nome && NOME_DE_EMPRESA.test(String(nome).normalize("NFC"));
}

/** Número de fachada: (11) 2222-2222, 0000-0000, 1234-5678… não é contato. */
export function telefoneDeFachada(t) {
  if (!t) return false;
  const local = String(t).slice(2);
  return /^(\d)\1+$/.test(local) || /^9?(\d)\1{7}$/.test(local) || /12345678|87654321/.test(local);
}

/**
 * Última palavra sobre quem anuncia. O portal pode dizer "particular", mas o
 * nome e o telefone desmentem: empresa no nome vira Imobiliária, número de
 * fachada sai do cartão.
 */
function revisarQuem(o, _plano) {
  if (telefoneDeFachada(o.telefone)) o = { ...o, telefone: null };
  if ((o.quem === "Proprietário" || o.quem === "Anunciante") && nomeDeEmpresa(o.anunciante)) o = { ...o, quem: "Imobiliária" };
  return o;
}

/** O VivaReal manda o tipo em código inglês (APARTMENT, ALLOTMENT_LAND...). */
const TIPO_VIVAREAL = {
  APARTMENT: "Apartamento", PENTHOUSE: "Cobertura", KITNET: "Kitnet", FLAT: "Flat", HOME: "Casa",
  TWO_STORY_HOUSE: "Sobrado", CONDOMINIUM: "Casa de condomínio", VILLAGE_HOUSE: "Casa de vila",
  ALLOTMENT_LAND: "Terreno", RESIDENTIAL_ALLOTMENT_LAND: "Terreno", COMMERCIAL_ALLOTMENT_LAND: "Terreno comercial",
  FARM: "Sítio / chácara", COUNTRY_HOUSE: "Chácara", OFFICE: "Sala comercial", COMMERCIAL_BUILDING: "Prédio comercial",
  BUILDING: "Prédio", BUSINESS: "Ponto comercial", STORE: "Loja", SHED_DEPOSIT_WAREHOUSE: "Galpão",
  COMMERCIAL_PROPERTY: "Imóvel comercial", HOTEL: "Hotel", CLINIC: "Clínica", PARKING_SPACE: "Garagem",
};
function categoriaVivaReal(v) {
  if (!v) return null;
  const k = String(v).trim().toUpperCase();
  return TIPO_VIVAREAL[k] ?? (/^[A-Z_]+$/.test(k) ? k.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : v);
}

/** Grupo de comparação de preço/m²: terreno não se compara com apartamento. */
function grupoDoTipo(categoria) {
  const t = normalizar(categoria);
  if (/terreno|lote|sitio|chacara|fazenda/.test(t)) return "terreno";
  if (/comerc|sala|loja|galp|predio|ponto|hotel|clinica/.test(t)) return "comercial";
  if (/casa|sobrado/.test(t)) return "casa";
  if (/apart|cobertura|kitnet|flat|apto/.test(t)) return "apartamento";
  return "outro";
}

/** Ordem de interesse: proprietário na frente, quem não tem telefone no fim. */
const PESO_CONTATO = { "Proprietário": 4, Corretor: 3, Imobiliária: 2, Anunciante: 2 };
function pesoDe(o) {
  if (!o.telefone) return 1;
  // Carteira tem telefone — dá para ligar —, mas é spam do mesmo número em
  // muitos anúncios. Fica entre "sem telefone" e o anunciante de um anúncio
  // só, para não roubar a frente de quem é lead de verdade.
  if (ehCarteira(o)) return 1.5;
  return PESO_CONTATO[o.quem] ?? 2;
}

/**
 * Intercala os anúncios pelos portais, DENTRO de cada faixa de interesse.
 *
 * Medido: com os três portais no ar, o Chaves na Mão trazia trinta anúncios
 * com telefone e o VivaReal outros trinta, e as dez vagas iam todas para o
 * primeiro — o segundo portal existia só para gastar crédito. Dez cartões da
 * mesma fonte também é pior para quem busca: repete os mesmos imóveis e
 * esconde metade do mercado.
 *
 * A intercalação NÃO atravessa faixas: um proprietário continua passando na
 * frente de qualquer imobiliária, venha de onde vier. Ela só decide a ordem
 * entre iguais.
 */
function intercalarPorPortal(lista) {
  const faixas = new Map();
  for (const o of lista) {
    const peso = pesoDe(o);
    if (!faixas.has(peso)) faixas.set(peso, new Map());
    const porPortal = faixas.get(peso);
    if (!porPortal.has(o.portal)) porPortal.set(o.portal, []);
    porPortal.get(o.portal).push(o);
  }

  const saida = [];
  for (const peso of [...faixas.keys()].sort((a, b) => b - a)) {
    const filas = [...faixas.get(peso).values()];
    let sobrou = true;
    while (sobrou) {
      sobrou = false;
      for (const fila of filas) {
        const proximo = fila.shift();
        if (proximo) {
          saida.push(proximo);
          sobrou = true;
        }
      }
    }
  }
  return saida;
}

function normalizarChavesNaMao(payload) {
  return (payload?.data?.items ?? []).map((i) => {
    const end = i?.address ?? {};
    const contato = contatoPublicado(i?.advertiser);
    const preco = Number(i?.prices?.rawPrice) || null;
    return {
      portal: "Chaves na Mão",
      url: String(i?.url ?? ""),
      titulo: String(i?.title ?? "Anúncio"),
      preco,
      // "R$ Confira" quando o anunciante não publicou valor.
      preco_texto: preco ? null : (i?.prices?.main ?? null),
      bairro: String(end.neighborhood ?? "").trim() || null,
      cidade: String(end.city ?? "").trim() || null,
      uf: String(end.state ?? "").trim() || null,
      categoria: i?.realtyType?.name ?? null,
      quartos: i?.counts?.bedrooms?.count ?? null,
      area_m2: i?.area?.useful ?? i?.area?.total ?? null,
      vagas: i?.counts?.garages?.count ?? null,
      banheiros: i?.counts?.bathrooms?.count ?? null,
      condominio: inteiro(i?.prices?.condominiumFee),
      iptu: inteiro(i?.prices?.iptuValue),
      foto: typeof i?.images?.[0] === "string" ? i.images[0] : (i?.images?.[0]?.url ?? null),
      publicado_em: i?.updatedAt ?? null,
      anunciante: contato?.nome ?? null,
      telefone: contato?.telefone ?? null,
      quem: contato?.quem ?? null,
    };
  });
}

// =================== VivaReal ===================

function urlZap(cidade, uf, finalidade, pagina) {
  // ZAP e VivaReal são o MESMO grupo (Grupo Zap, glue-api), então a resposta
  // tem o mesmo shape e o parser é o do VivaReal. A URL segue o padrão do ZAP:
  // /venda|aluguel/imoveis/<uf>+<cidade>/. Precisa de UMA validação ao vivo
  // antes de virar padrão — por isso nasce desligado em JAZZ_PORTAIS.
  const caminho = finalidade === "Locação" ? "aluguel" : "venda";
  const base = `https://www.zapimoveis.com.br/${caminho}/imoveis/${slug(uf) || "sp"}+${slug(cidade)}/`;
  return pagina > 1 ? `${base}?pagina=${pagina}` : base;
}

function normalizarZap(payload) {
  // Mesmo shape do VivaReal; só troca o rótulo do portal.
  return normalizarVivaReal(payload).map((o) => ({ ...o, portal: "ZAP" }));
}

function urlVivaReal(cidade, uf, finalidade, pagina) {
  const caminho = finalidade === "Locação" ? "aluguel" : "venda";
  const base = `https://www.vivareal.com.br/${caminho}/${slug(uf) || "sp"}/${slug(cidade)}/`;
  return pagina > 1 ? `${base}?pagina=${pagina}` : base;
}

/**
 * O VivaReal publica telefone em praticamente todo anúncio, e quase todos são
 * de imobiliária. Enquanto o filtro estrito valia, ele não tinha o que somar;
 * agora é a maior fonte de cartão COM número na tela.
 *
 * Os caminhos dos campos são tentados em mais de uma forma de propósito: a
 * resposta deste portal não foi medida com a mesma profundidade dos outros
 * dois, e uma chave ausente deve virar `null`, nunca uma exceção que derruba
 * a busca inteira.
 */
function normalizarVivaReal(payload, plano = {}) {
  return (payload?.data?.items ?? []).map((i) => {
    const end = i?.address ?? i?.location ?? {};
    const anunciante = i?.advertiser ?? null;
    const contato = contatoVivaReal(anunciante, !!plano.direto);
    // Busca estruturada devolve `prices` como lista; a de URL, como objeto.
    const precos = Array.isArray(i?.prices) ? (i.prices.find((p) => p?.value) ?? {}) : (i?.prices ?? {});
    const preco = Number(precos.rawPrice ?? precos.value ?? i?.price ?? precos.price) || null;
    return {
      portal: "VivaReal",
      url: String(i?.url ?? i?.link ?? ""),
      titulo: String(i?.title ?? i?.name ?? "Anúncio"),
      preco,
      preco_texto: preco ? null : (precos.main ?? i?.priceDisplay ?? null),
      bairro: String(end.neighborhood ?? end.neighbourhood ?? "").trim() || null,
      cidade: String(end.city ?? "").trim() || null,
      // A sigla vem primeiro: o VivaReal manda o nome por extenso em `state`, e
      // cortar "São Paulo" em duas letras produzia "SÃ" no cartão.
      uf: String(end.stateAcronym ?? end.state ?? "").trim().slice(0, 2).toUpperCase() || null,
      categoria: categoriaVivaReal(i?.realtyType?.name ?? i?.unitType ?? i?.unitTypes?.[0] ?? i?.type ?? null),
      quartos: inteiro(i?.counts?.bedrooms?.count ?? i?.attributes?.bedrooms?.[0] ?? i?.bedrooms),
      area_m2: inteiro(i?.area?.useful ?? i?.area?.total ?? i?.attributes?.usableAreas?.[0] ?? i?.usableArea),
      vagas: inteiro(i?.counts?.garages?.count ?? i?.attributes?.parkingSpaces?.[0] ?? i?.parkingSpaces),
      banheiros: inteiro(i?.counts?.bathrooms?.count ?? i?.attributes?.bathrooms?.[0] ?? i?.bathrooms),
      condominio: inteiro(precos.condominiumFee ?? precos.condominium ?? i?.condominiumFee),
      iptu: inteiro(precos.iptuValue ?? precos.iptu ?? i?.iptu),
      foto: typeof i?.images?.[0] === "string" ? i.images[0] : (i?.images?.[0]?.url ?? fotoDaMidia(i?.media)),
      publicado_em: i?.updatedAt ?? i?.createdAt ?? null,
      anunciante: contato?.nome ?? null,
      telefone: contato?.telefone ?? null,
      quem: contato?.quem ?? null,
    };
  });
}

/**
 * Metade da página reservada para quem anuncia o próprio imóvel.
 *
 * Por que a ordenação sozinha não resolvia: `pesoDe` manda para o fim tudo que
 * não tem telefone, e a OLX — o portal onde o particular de fato está — não
 * publica telefone nenhum. Resultado medido em 04/09: São José dos Campos
 * devolvia 1 proprietário em 10 e Campinas 0 em 10, com ZERO cartões da OLX na
 * página. Os anúncios de particular existiam, liam-se dezenas deles, e todos
 * caíam fora no corte dos dez porque imobiliária com telefone pesa mais que
 * proprietário sem.
 *
 * A reserva inverte isso sem esvaziar a página: metade das vagas só pode ser
 * ocupada por proprietário, e as duas metades saem alternadas, para o
 * particular aparecer no alto e ao longo da lista, não empilhado no rodapé.
 * Quando faltar proprietário, a vaga volta para o profissional em vez de ficar
 * vazia — meia página cheia é pior para quem busca do que uma página cheia com
 * menos particulares, e `com_pessoa_fisica` conta a verdade do que saiu.
 *
 * Corretor não entra na cota: tem CRECI, vive de intermediar, e a conversa é a
 * mesma de imobiliária.
 */
const COTA_PESSOA_FISICA = 0.5;

function ehPessoaFisica(o) {
  // "Proprietário" que aparece com o mesmo telefone em muitos anúncios não é
  // dono — é corretor cadastrado como pessoa física. A vaga reservada é para
  // dono de verdade, então a carteira sai dela.
  return o.quem === "Proprietário" && !ehCarteira(o);
}

function comCotaDePessoaFisica(lista, alvo) {
  const fisicas = lista.filter(ehPessoaFisica);
  const profissionais = lista.filter((o) => !ehPessoaFisica(o));

  // A cota é PISO, não teto, e vale só numa direção. Quando o particular já
  // ganha mais da metade por mérito próprio, ele fica com o que ganhou; a
  // reserva nunca devolve vaga para o profissional. E quando falta
  // profissional para fechar os dez, a sobra também é do particular.
  const porMerito = lista.slice(0, alvo).filter(ehPessoaFisica).length;
  const daPessoa = Math.min(
    fisicas.length,
    Math.max(porMerito, Math.ceil(alvo * COTA_PESSOA_FISICA), alvo - profissionais.length),
  );
  const doProfissional = Math.min(profissionais.length, alvo - daPessoa);

  // Alternado, começando pelo particular: espalha a metade reservada pela
  // página em vez de empilhá-la no rodapé, onde ninguém rola.
  const saida = [];
  for (let i = 0; i < Math.max(daPessoa, doProfissional); i++) {
    if (i < daPessoa) saida.push(fisicas[i]);
    if (i < doProfissional) saida.push(profissionais[i]);
  }
  return saida.slice(0, alvo);
}

// =================== Busca ===================

/**
 * @param {object} p
 * @param {string} p.cidade       obrigatória
 * @param {string} [p.uf]         sigla do estado; entra na URL do Chaves na Mão
 * @param {string} [p.bairro]
 * @param {"Venda"|"Locação"} [p.finalidade]
 * @param {number} [p.precoMin]   0 = sem piso
 * @param {number} [p.precoMax]   0 = sem teto
 * @param {number} [p.quartosMin] 0 = qualquer
 * @param {number} [p.areaMin]    em m², 0 = qualquer
 * @param {number} [p.vagasMin]   0 = qualquer
 * @param {string} [p.tipo]       Casa | Apartamento | Terreno | Comercial
 * @param {number} [p.pagina]     rodízio, contado pelo cliente
 * @param {string} [p.chave]      GECKO_API_KEY
 * @returns {Promise<{status: number, corpo: object}>}
 */
export async function buscarOpcoes({
  cidade,
  uf = "SP",
  bairro = "",
  finalidade = "Venda",
  precoMin = 0,
  precoMax = 0,
  quartosMin = 0,
  areaMin = 0,
  vagasMin = 0,
  tipo = "",
  pagina = 0,
  // Só proprietário por padrão. Imobiliária e corretor só entram quando quem
  // busca pede, e mesmo assim depois de todos os donos.
  profissionais = false,
  codigo = "",
  ip = "",
  chave,
}) {
  cidade = String(cidade ?? "").trim().slice(0, 80);
  uf = String(uf ?? "SP").trim().slice(0, 2).toUpperCase() || "SP";
  bairro = String(bairro ?? "").trim().slice(0, 80);
  finalidade = finalidade === "Locação" ? "Locação" : "Venda";
  precoMin = naoNegativo(precoMin);
  precoMax = naoNegativo(precoMax);
  quartosMin = naoNegativo(quartosMin);
  areaMin = naoNegativo(areaMin);
  vagasMin = naoNegativo(vagasMin);
  tipo = TIPOS[tipo] ? tipo : "";

  // Piso acima do teto não devolve nada e o usuário não entende por quê.
  // Trocar é o que ele quis dizer.
  if (precoMin && precoMax && precoMin > precoMax) {
    [precoMin, precoMax] = [precoMax, precoMin];
  }

  // O portão vem ANTES de qualquer chamada paga: código errado não pode
  // custar crédito.
  if (!codigoConfere(codigo)) {
    return {
      status: 401,
      corpo: { erro: "Código de acesso inválido. Peça o código à Jazz.", motivo: "codigo_invalido" },
    };
  }

  if (cidade.length < 2) {
    return { status: 400, corpo: { erro: "Informe a cidade." } };
  }

  // Depois do código e da cidade, antes de qualquer chamada paga.
  const excedeu = podeConsultar(ip);
  if (excedeu) {
    return { status: 200, corpo: { opcoes: [], alvo: ALVO, motivo: excedeu } };
  }
  if (!chave) {
    return {
      status: 200,
      corpo: { opcoes: [], alvo: ALVO, motivo: "gecko_nao_configurada", dica: diagnosticoChave() },
    };
  }

  const pg = paginaDaBusca(pagina);
  // Planos = uma chamada paga por item. Quais portais entram sai de
  // `portaisAtivos()` (env JAZZ_PORTAIS), então o custo é configurável sem
  // publicar de novo.
  const planos = montarPlanos({ bairro, cidade, uf, finalidade, tipo, pg, precoMin, precoMax, areaMin, quartosMin, vagasMin });

  const bloqueio = podeChamar(planos.length);
  if (bloqueio) {
    return { status: 200, corpo: { opcoes: [], alvo: ALVO, motivo: bloqueio } };
  }

  const chamadas = planos.map((pl) => gecko(chave, pl.url, pl.target));
  // Um portal lento não deve segurar o outro, e um fora do ar não pode zerar a
  // página — por isso allSettled e não all.
  const respostas = await Promise.allSettled(chamadas);

  // Em allSettled, um item rejeitado não tem `.value` — ler direto daria
  // undefined e mascararia a falha como "portal vazio".
  const payloads = respostas.map((r) => (r.status === "fulfilled" ? r.value : null));
  if (payloads.every((p) => !p)) {
    return { status: 200, corpo: { opcoes: [], alvo: ALVO, motivo: "portal_indisponivel" } };
  }

  // Contamos ANTES de peneirar. Sem isto, uma busca que devolve só OLX parece
  // "o outro portal nem foi consultado", quando na verdade ele respondeu e
  // nenhum anúncio era de proprietário com telefone público. São coisas
  // diferentes e a página precisa saber distinguir.
  // Agrupado por portal, por NOME e não por posição: acrescentar um portal não
  // desalinha mais nada. Cada plano normaliza o próprio payload.
  const nomesPortais = [...new Set(planos.map((pl) => pl.portal))];
  const anunciadosDoPortal = (nome) =>
    planos.reduce((n, pl, i) => pl.portal === nome ? n + (payloads[i]?.data?.items?.length ?? 0) : n, 0);
  const respondeuPortal = (nome) => planos.some((pl, i) => pl.portal === nome && payloads[i]);
  const primeiroItemPortal = (nome) => {
    for (let i = 0; i < planos.length; i++) {
      if (planos[i].portal === nome && payloads[i]?.data?.items?.length) return payloads[i].data.items[0];
    }
    return undefined;
  };

  const brutos = planos.flatMap((pl, i) => pl.normaliza(payloads[i], pl).map((o) => revisarQuem(o, pl)));

  // Puxamos duas páginas do Chaves na Mão, e o mesmo anúncio pode estar nas
  // duas. Contar sem tirar a repetição diria "2 proprietários" onde há um só.
  // Esta é a ÚNICA passada de deduplicação: o laço de filtros abaixo percorre
  // `distintos`, e não `brutos`. Antes eram duas — este Map e um Set dentro do
  // laço —, cada uma com sua própria noção de repetido.
  const distintos = [...new Map(
    brutos.filter((o) => /^https?:\/\//.test(o.url)).map((o) => [o.url, o]),
  ).values()];

  // Quantos anúncios distintos cada telefone assina, no conjunto já sem
  // repetição de URL. É o que separa dono de carteira sem custo de coleta
  // nenhum — o dado já veio junto. Anotado aqui para `pesoDe`, `ehPessoaFisica`
  // e o diagnóstico enxergarem o mesmo número.
  // Cross-post: o MESMO imóvel anunciado em PORTAIS DIFERENTES vem com URLs
  // diferentes, então o dedup por URL não o pega. Colapsa só quando a mesma
  // assinatura (telefone, preço, área, quartos, bairro) reaparece em OUTRO
  // portal — mantendo a primeira vista, na ordem de relevância.
  //
  // "Portais diferentes" é a trava que faz isto ser seguro: dois anúncios com a
  // mesma assinatura no MESMO portal são listagens distintas (a URL já
  // deduplicou), e colapsá-las apagaria inventário E o sinal de carteira, que
  // depende justamente de contar vários anúncios do mesmo telefone. Sem os
  // cinco campos preenchidos, não há chave e não se arrisca colapsar nada.
  const vistoEm = new Map();
  const semCrossPost = [];
  for (const o of distintos) {
    const temChave = o.telefone && o.preco && o.area_m2 && o.quartos && o.bairro;
    if (!temChave) { semCrossPost.push(o); continue; }
    const k = [o.telefone, o.preco, o.area_m2, o.quartos, normalizar(o.bairro)].join("|");
    const portais = vistoEm.get(k);
    if (portais && !portais.has(o.portal)) continue;   // mesmo imóvel, outro portal
    if (portais) portais.add(o.portal);
    else vistoEm.set(k, new Set([o.portal]));
    semCrossPost.push(o);
  }

  const porTelefone = new Map();
  for (const o of semCrossPost) {
    if (o.telefone) porTelefone.set(o.telefone, (porTelefone.get(o.telefone) ?? 0) + 1);
  }
  for (const o of semCrossPost) {
    o.anuncios_no_telefone = o.telefone ? porTelefone.get(o.telefone) : null;
  }

  const cidadeNorm = normalizar(cidade);
  const bairroNorm = normalizar(bairro);
  const minimoPreco = finalidade === "Locação" ? 300 : 10_000;

  const candidatos = [];

  for (const o of semCrossPost) {
    const precoValido = Number.isFinite(o.preco) && o.preco >= minimoPreco;
    if (precoValido && precoMax > 0 && o.preco > precoMax) continue;
    if (precoValido && precoMin > 0 && o.preco < precoMin) continue;
    if (!casaComTipo(tipo, o.categoria)) continue;
    if (quartosMin > 0 && (o.quartos ?? 0) < quartosMin) continue;
    if (areaMin > 0 && (o.area_m2 ?? 0) < areaMin) continue;
    if (vagasMin > 0 && (o.vagas ?? 0) < vagasMin) continue;
    if (cidadeNorm && !normalizar(o.cidade).includes(cidadeNorm)) continue;

    // O bairro é PREFERÊNCIA, não corte. Ele já entra na busca do portal;
    // exigir aqui que o campo bairro contenha o texto digitado descartava o
    // imóvel certo por diferença de grafia ("Jd. Paulista" x "Jardim
    // Paulista"), e a página devolvia zero resultado num bairro cheio deles.
    const bairroCasou = !bairroNorm || normalizar(o.bairro).includes(bairroNorm);

    candidatos.push({
      ...o,
      bairroCasou,
      preco: precoValido ? o.preco : null,
      // O texto do portal não pode ressuscitar um preço que acabamos de
      // recusar. "R$ 1.000" numa venda é entrada ou "a partir de", e a página
      // exibia como se fosse o valor do imóvel; "R$ Confira" é recado do
      // portal. Sem texto, a página diz "Preço sob consulta", que é a
      // verdade.
      preco_texto: precoValido ? o.preco_texto : null,
      // Preço por m² é como o mercado brasileiro compara imóvel; calcular aqui
      // evita a conta de cabeça e revela na hora o que está caro ou barato.
      preco_m2: precoValido && o.area_m2 ? Math.round(o.preco / o.area_m2) : null,
      // Dias desde o anúncio. Dono recém-publicado é lead mais quente: ainda
      // não fechou com imobiliária. Vira "há X dias" na tela e desempata no
      // ranking (mais novo primeiro).
      dias: diasDesde(o.publicado_em),
    });
  }

  // AÇÃO oportunidade: preço/m² bem abaixo da mediana do próprio resultado é
  // quem quer vender rápido — melhor alvo de captação, melhor barganha de
  // compra. Mediana do próprio conjunto para não depender de tabela externa.
  // Mediana POR TIPO: em Jacareí (11/10/2026) terreno a R$ 47/m² saía
  // "abaixo do mercado" porque era comparado com apartamento. Grupo com menos
  // de 3 anúncios com preço/m² não tem base para dizer nada.
  const porGrupo = new Map();
  for (const c of candidatos) {
    if (c.preco_m2 == null) continue;
    const g = grupoDoTipo(c.categoria);
    if (!porGrupo.has(g)) porGrupo.set(g, []);
    porGrupo.get(g).push(c.preco_m2);
  }
  for (const c of candidatos) {
    const lista = porGrupo.get(grupoDoTipo(c.categoria)) ?? [];
    const medianaM2 = lista.length >= 3 ? mediana(lista) : null;
    c.abaixo_mercado =
      medianaM2 != null && c.preco_m2 != null && c.preco_m2 <= medianaM2 * DESCONTO_OPORTUNIDADE;
  }

  // Proprietário com telefone primeiro, depois corretor, depois imobiliária,
  // e só então quem não tem número. Ninguém mais é descartado por ser
  // profissional — a ordem faz o trabalho que o filtro fazia, sem esvaziar a
  // página. Empate desce para o bairro pedido, e o resto mantém a ordem do
  // portal, que já é relevância de busca.
  const ordenados = candidatos.sort((a, b) =>
    pesoDe(b) - pesoDe(a) ||
    Number(b.bairroCasou) - Number(a.bairroCasou) ||
    // Empate final: o anúncio mais novo na frente. Data ausente vai para o fim.
    (a.dias ?? 99999) - (b.dias ?? 99999));

  // A página promete o DONO. Antes, a cota deixava metade das vagas para
  // imobiliária, e na busca de Taubaté (10/10/2026) 7 dos 10 cartões eram de
  // profissional. Agora profissional só aparece se quem busca pedir.
  const donos = ordenados.filter(ehPessoaFisica);
  const profissionaisOcultos = ordenados.length - donos.length;
  const escolhidos = profissionais
    ? comCotaDePessoaFisica(intercalarPorPortal(ordenados), ALVO)
    : intercalarPorPortal(donos).slice(0, ALVO);
  // Quem pediu um bairro precisa saber quando o cartão é de outro (vem da
  // página da cidade inteira que completa a lista).
  const opcoes = escolhidos.map(({ bairroCasou, ...o }) => (bairroNorm && !bairroCasou ? { ...o, fora_do_bairro: true } : o));

  return {
    status: 200,
    corpo: {
      opcoes,
      alvo: ALVO,
      com_telefone: opcoes.filter((o) => o.telefone).length,
      // Quanto cada portal rendeu, para a página poder mostrar o que foi
      // vasculhado. "Nenhum resultado da OLX" e "a OLX não respondeu" viram a
      // mesma tela sem isto, e não são o mesmo problema.
      com_proprietario: opcoes.filter((o) => o.telefone && o.quem === "Proprietário").length,
      // Quantos cartões são de quem anuncia o próprio imóvel, COM ou SEM
      // telefone na tela. É a conta que responde "metade é pessoa física?" —
      // `com_proprietario` responde outra, "quantos dá para ligar agora".
      com_pessoa_fisica: opcoes.filter(ehPessoaFisica).length,
      // Quantos dos exibidos são carteira (mesmo telefone em muitos anúncios).
      // Mostra ao captador quanto da página é operação repetida e não lead
      // novo — a mesma honestidade do "N na página" por portal.
      com_carteira: opcoes.filter(ehCarteira).length,
      // Quantos dos exibidos estão abaixo do mercado (preço/m² baixo). É o
      // atalho do captador para o dono apressado.
      com_oportunidade: opcoes.filter((o) => o.abaixo_mercado).length,
      // Imobiliárias, corretores e carteiras que ficaram de fora por não serem
      // o dono. A página oferece mostrá-los, em vez de escondê-los calada.
      profissionais_ocultos: profissionais ? 0 : profissionaisOcultos,
      so_proprietarios: !profissionais,
      fontes: nomesPortais.map((nome) =>
        resumo(nome, respondeuPortal(nome), anunciadosDoPortal(nome), distintos, opcoes,
          primeiroItemPortal(nome))),
      // Número da Jazz para o convite no rodapé. Sai da configuração e não do
      // código: sem ele o convite simplesmente não aparece, em vez de a página
      // exibir um link quebrado.
      jazz_whatsapp: String(process.env.JAZZ_WHATSAPP ?? "").replace(/\D/g, "") || null,
      // Mensagem que a página põe no wa.me, configurável sem publicar de novo.
      // Placeholders {titulo}, {bairro}, {cidade}. Vazio -> a página usa o
      // texto padrão de comprador. Existe para a Jazz trocar por uma abordagem
      // de CAPTAÇÃO ("ajudo a vender o seu imóvel") quando usar internamente,
      // sem tocar no código.
      wpp_template: process.env.JAZZ_WPP_TEMPLATE || null,
      // Quando a cidade é escrita de um jeito que o portal não reconhece, a
      // busca volta cheia mas nada casa. Vale distinguir isso de "não achei".
      // A ordem importa: um portal fora explica melhor uma lista curta do que
      // "nada bateu com os filtros", e antes disso a página devolvia lista
      // vazia sem motivo nenhum — o visitante achava que a busca estava
      // quebrada quando o problema era momentâneo e de fora.
      motivo:
        opcoes.length < ALVO && payloads.some((p) => !p) ? "portal_instavel"
        : opcoes.length === 0 && profissionaisOcultos > 0 && !profissionais ? "so_profissionais"
        : opcoes.length === 0 && brutos.length > 0 ? "nenhum_particular_no_filtro"
        : null,
    },
  };
}

/**
 * Uma linha do diagnóstico: o que o portal devolveu e o que sobrou dele.
 *
 * Quando o portal traz anúncios e NENHUM sobrevive, a linha carrega também os
 * nomes dos campos do primeiro item. É o sintoma clássico de normalizador
 * apontando para a chave errada — foi assim que o VivaReal ficou lendo trinta
 * anúncios por busca e entregando zero. Sem isso, a única saída é adivinhar o
 * formato e publicar de novo para ver no que deu.
 *
 * São só nomes de campo de anúncio público: nada de segredo, nada de dado
 * pessoal.
 */
function resumo(portal, respondeu, anuncios, distintos, opcoes, primeiroItem) {
  // Anúncio sem URL é anúncio que a página não tem como mostrar: contar como
  // "encontrado" esconderia justamente o normalizador que errou a chave.
  const meus = distintos.filter(
    (o) => o.portal === portal && /^https?:\/\//.test(String(o.url ?? "")),
  );
  const linha = {
    portal,
    respondeu,
    anuncios,
    // Anúncios distintos que o portal trouxe, antes dos filtros de busca.
    encontrados: meus.length,
    com_telefone: meus.filter((o) => o.telefone).length,
    proprietarios: meus.filter((o) => o.quem === "Proprietário").length,
    exibidos: opcoes.filter((o) => o.portal === portal).length,
  };
  // Alarme de normalizador errado.
  //
  // "Zero exibidos" NÃO serve de sintoma, e isso me custou uma rodada: o
  // VivaReal aparecia com trinta encontrados e zero exibidos, e eu conclui
  // que ele estava quebrado. Estava certo — só perdia as dez vagas para o
  // Chaves na Mão, que naquela busca trouxe trinta anúncios COM telefone.
  // Ser passado para trás na ordenação é o sistema funcionando.
  //
  // O sintoma que presta é o anúncio chegar sem os campos que a página
  // precisa: sem cidade ele morre no filtro, sem URL não vira cartão.
  linha.com_cidade = meus.filter((o) => o.cidade).length;
  const perdido = linha.encontrados === 0 || linha.com_cidade === 0;
  if (anuncios > 0 && perdido && primeiroItem) {
    linha.campos_ignorados = Object.keys(primeiroItem).slice(0, 40);
    const end = primeiroItem.address ?? primeiroItem.location ?? null;
    if (end && typeof end === "object") linha.campos_do_endereco = Object.keys(end).slice(0, 20);
  }
  // Telefone é o que a página promete. Um portal que traz anunciante e nenhum
  // número tem o contato em outra chave, e a forma do anunciante diz qual.
  if (anuncios > 0 && linha.com_telefone === 0 && primeiroItem?.advertiser) {
    linha.campos_do_anunciante = Object.keys(primeiroItem.advertiser).slice(0, 20);
    const fones = primeiroItem.advertiser.phones;
    if (fones && typeof fones === "object") {
      linha.forma_dos_telefones = Array.isArray(fones) ? "lista" : Object.keys(fones).slice(0, 10);
    }
  }
  return linha;
}

/** Lê os parâmetros aceitos pela busca a partir de um URLSearchParams. */
export function lerParametros(params) {
  return {
    codigo: params.get("codigo") ?? "",
    cidade: params.get("cidade") ?? "",
    uf: params.get("uf") ?? "SP",
    bairro: params.get("bairro") ?? "",
    finalidade: params.get("finalidade") ?? "Venda",
    precoMin: Number(params.get("preco_min") ?? 0) || 0,
    precoMax: Number(params.get("preco_max") ?? 0) || 0,
    quartosMin: Number(params.get("quartos") ?? 0) || 0,
    areaMin: Number(params.get("area_min") ?? 0) || 0,
    vagasMin: Number(params.get("vagas") ?? 0) || 0,
    tipo: params.get("tipo") ?? "",
    pagina: Number(params.get("pagina") ?? 0) || 0,
    profissionais: params.get("profissionais") === "1",
    chave: process.env.GECKO_API_KEY,
  };
}
