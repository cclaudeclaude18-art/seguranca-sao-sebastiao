const express = require("express");
const fetch   = require("node-fetch");
const app     = express();
app.use(express.json());

// =====================================================
// DADOS DO PROJETO — São Sebastião DF
// =====================================================
const TOKEN_BOT    = "7661468638:AAFjfveABE54v62Vn-ZFvl9Rz0hgWuiYRPw";
const CANAL_ID     = "-1003962050836";
const URL_FIREBASE = "https://seguranca-sao-sebastiao-dee0a-default-rtdb.firebaseio.com/alertas";
const URL_API      = `https://api.telegram.org/bot${TOKEN_BOT}`;

// =====================================================
// VALIDAÇÃO DE ÁREA — São Sebastião DF
// =====================================================
const AREA = {
  LAT_MIN: -16.05,
  LAT_MAX: -15.80,
  LNG_MIN: -47.90,
  LNG_MAX: -47.70
};

function localizacaoValida(lat, lng) {
  return lat >= AREA.LAT_MIN && lat <= AREA.LAT_MAX &&
         lng >= AREA.LNG_MIN && lng <= AREA.LNG_MAX;
}

// =====================================================
// CACHE em memória
// =====================================================
const cache = {};

// Mapa de SOS ativos: chatId -> { alertaId, timer }
const sosAtivos = {};

async function registrarSOS(chatId, alertaId) {
  // cancela timer anterior se existir
  if (sosAtivos[chatId]) clearTimeout(sosAtivos[chatId].timer);

  // persiste no Firebase para sobreviver reinício do servidor
  const expira = Date.now() + 60 * 60 * 1000;
  try {
    await fetch(`https://seguranca-sao-sebastiao-dee0a-default-rtdb.firebaseio.com/sos_ativos/${chatId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertaId, expira, chatId })
    });
  } catch(e) { console.error("Erro ao persistir SOS:", e); }

  const timer = setTimeout(async () => {
    await cancelarSOS(chatId, alertaId, true);
  }, 60 * 60 * 1000); // 1 hora

  sosAtivos[chatId] = { alertaId, timer };
}

// Restaurar SOS ativos ao iniciar servidor (caso tenha reiniciado)
async function restaurarSOSAtivos() {
  try {
    const r = await fetch(`https://seguranca-sao-sebastiao-dee0a-default-rtdb.firebaseio.com/sos_ativos.json`);
    const d = await r.json();
    if (!d) return;
    const agora = Date.now();
    for (const [chatId, dados] of Object.entries(d)) {
      if (!dados || !dados.alertaId) continue;
      const restante = dados.expira - agora;
      if (restante <= 0) {
        // já expirou — cancelar
        await cancelarSOS(chatId, dados.alertaId, true);
      } else {
        // reagendar timer com tempo restante
        const timer = setTimeout(async () => {
          await cancelarSOS(chatId, dados.alertaId, true);
        }, restante);
        sosAtivos[chatId] = { alertaId: dados.alertaId, timer };
        console.log(`SOS restaurado: chatId ${chatId}, expira em ${Math.round(restante/60000)}min`);
      }
    }
  } catch(e) { console.error("Erro ao restaurar SOS:", e); }
}

async function cancelarSOS(chatId, alertaId, automatico = false) {
  if (sosAtivos[chatId]) {
    clearTimeout(sosAtivos[chatId].timer);
    delete sosAtivos[chatId];
  }
  // remover do Firebase de SOS ativos
  try {
    await fetch(`https://seguranca-sao-sebastiao-dee0a-default-rtdb.firebaseio.com/sos_ativos/${chatId}.json`, {
      method: "DELETE"
    });
  } catch(e) { console.error("Erro ao remover SOS ativo:", e); }
  // marcar como resolvido no Firebase
  try {
    await fetch(`${URL_FIREBASE}/${alertaId}.json`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ status: "resolvido" })
    });
    // notificar canal
    const txt = automatico
      ? `✅ *SOS encerrado automaticamente*

_Nenhum cancelamento manual em 1 hora. Alerta removido do mapa._`
      : `✅ *SOS CANCELADO — Estou bem!*

_A pessoa confirmou que está segura. Alerta removido do mapa._`;
    await fetch(`${URL_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CANAL_ID, text: txt, parse_mode: "Markdown" })
    });
  } catch(e) { console.error("Erro ao cancelar SOS:", e); }
}

// =====================================================
// PING — mantém o servidor acordado
// =====================================================
app.get("/ping", (req, res) => res.send("ok"));
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));

const https = require("https");
setInterval(() => {
  https.get("https://seguranca-sao-sebastiao.onrender.com/ping", () => {});
}, 14 * 60 * 1000);

// =====================================================
// RECEBE MENSAGENS DO TELEGRAM
// =====================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const dados = req.body;
  const msg   = dados.message;
  const cb    = dados.callback_query;

  if (cb) {
    if (cb.data.startsWith("cat_")) {
      await guardarCategoria(cb);
    } else {
      await processarVoto(cb);
    }
    return;
  }

  if (!msg) return;

  const chatId = msg.chat.id;
  const texto  = msg.text || "";
  const local  = msg.location || null;

  if (local) {
    const { latitude: lat, longitude: lng } = local;

    if (!localizacaoValida(lat, lng)) {
      await enviarMensagem(chatId,
        "❌ Localização fora de São Sebastião — DF.\n\n" +
        "Este sistema é exclusivo para a comunidade de São Sebastião. " +
        "Certifique-se de estar na região e tente novamente."
      );
      delete cache[chatId];
      return;
    }

    await salvarAlerta(chatId, lat, lng);
    return;
  }

  if (texto === "/sos" || texto === "/start sos") {
    cache[chatId] = { desc: "🆘 EMERGÊNCIA — preciso de ajuda", tipo: "sos" };
    await enviarMensagem(chatId,
      "🆘 *SOS ATIVADO*\n\n" +
      "Seu pedido de emergência foi registrado. Envie sua localização agora para notificar a rede imediatamente."
    );
    await pedirLocalizacao(chatId, "📍 Onde você está? Envie sua localização:");
    return;
  }

  if (texto.startsWith("/alerta")) {
    const desc = texto.replace("/alerta", "").trim() || "Situação suspeita";
    cache[chatId] = { desc, tipo: "geral" };
    await pedirLocalizacao(chatId, "📌 Envie sua localização para registrar o alerta:");
    return;
  }

  if (texto === "/registrar" || texto === "/espaco") {
    await mostrarCategorias(chatId);
    return;
  }

  if (texto === "/estou_bem" || texto === "/estoubem" || texto === "/cancelar") {
    const sos = sosAtivos[chatId];
    if (!sos) {
      await enviarMensagem(chatId, "ℹ️ Nenhum SOS ativo encontrado para esta conversa.");
      return;
    }
    await cancelarSOS(chatId, sos.alertaId, false);
    await enviarMensagem(chatId, "✅ *Que alívio! SOS cancelado.*\n\nO alerta foi removido do mapa. Fique segura! 💜", null);
    return;
  }

  if (texto === "/contato") {
    const atual = await buscarContato(chatId);
    const msg = atual
      ? `📱 Seu contato de emergência atual: *${atual}*\n\nPara alterar, envie o número assim:\n/contato 61999999999`
      : `📱 Você ainda não tem um contato de emergência cadastrado.\n\nEnvie assim:\n/contato 61999999999\n\n_Este número será notificado pelo app quando você usar "Estou chegando"._`;
    await enviarMensagem(chatId, msg);
    return;
  }

  if (texto.startsWith("/contato ")) {
    const numero = texto.replace("/contato", "").trim().replace(/\D/g, "");
    if (numero.length < 10 || numero.length > 13) {
      await enviarMensagem(chatId, "❌ Número inválido. Envie com DDD, sem espaços ou traços.\nEx: /contato 61999999999");
      return;
    }
    await salvarContato(chatId, numero);
    await enviarMensagem(chatId,
      `✅ *Contato salvo!*\n\n📱 ${numero}\n\n` +
      `Este número será notificado automaticamente pelo app quando você ativar "Estou chegando" e não confirmar chegada no tempo definido.\n\n` +
      `_Para alterar, envie /contato + novo número._`
    );
    return;
  }

  await enviarMensagem(chatId,
    "👋 Bem-vinda à Rede de Segurança de São Sebastião — DF.\n\n" +
    "🆘 *SOS* — use o botão no app ou /sos\n" +
    "   ✅ Para cancelar: /estou\_bem\n\n" +
    "🚨 *Alerta geral* — /alerta + descrição\n" +
    "   Ex: /alerta Carro parado há horas\n\n" +
    "🚺 *Espaço Seguro* — /registrar\n\n" +
    "📱 *Contato de emergência* — /contato\n" +
    "   Ex: /contato 61999999999"
  );
  // avisar se não tem contato cadastrado
  const contatoBV = await buscarContato(chatId);
  if (!contatoBV) {
    await enviarMensagem(chatId,
      "⚠️ *Você ainda não tem um contato de emergência cadastrado.*\n\n" +
      "Cadastre agora o número de alguém de confiança — mãe, amiga, familiar — " +
      "que será avisado se você não confirmar chegada no app:\n\n" +
      "/contato 61999999999"
    );
  }
});

// =====================================================
// USUÁRIOS — contato de emergência salvo no Firebase
// =====================================================
const URL_USUARIOS = "https://seguranca-sao-sebastiao-dee0a-default-rtdb.firebaseio.com/usuarios";

async function buscarContato(chatId) {
  try {
    const r = await fetch(`${URL_USUARIOS}/${chatId}.json`);
    const d = await r.json();
    return d?.contato || null;
  } catch { return null; }
}

async function salvarContato(chatId, numero) {
  await fetch(`${URL_USUARIOS}/${chatId}.json`, {
    method:  "PUT",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ contato: numero, atualizado: new Date().toISOString() })
  });
}

// =====================================================
// FLUXO GERAL
// =====================================================
async function pedirLocalizacao(chatId, mensagem) {
  const teclado = {
    keyboard: [[{ text: "📍 Enviar minha localização", request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
  await enviarMensagem(chatId, mensagem, teclado);
}

async function salvarAlerta(chatId, lat, lng) {
  const dados     = cache[chatId] || {};
  const tipo      = dados.tipo      || "geral";
  const descricao = dados.desc      || dados.cat || "Situação suspeita";
  delete cache[chatId];

  const alerta = {
    descricao,
    tipo,
    lat,
    lng,
    hora:         new Date().toLocaleTimeString("pt-BR"),
    data:         new Date().toLocaleDateString("pt-BR"),
    confirmacoes: 0,
    negacoes:     0,
    status:       tipo === "mulher" ? "ativo" : (tipo === "sos" ? "sos" : "pendente")
  };

  const no = tipo === "mulher" ? "/alertas_mulheres" : "/alertas";
  const urlFirebase = `https://seguranca-sao-sebastiao-dee0a-default-rtdb.firebaseio.com${no}`;

  const resp = await fetch(urlFirebase + ".json", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(alerta)
  });
  const json = await resp.json();
  const id   = json.name;

  await notificarCanal(alerta, id);

  if (tipo === "sos") {
    registrarSOS(chatId, id);
    await enviarMensagem(chatId,
      "🆘 SOS registrado! A rede foi alertada. Fique segura — ajuda a caminho.\n\n" +
      "Quando estiver segura, envie /estou\_bem para cancelar o alerta.\n" +
      "_O alerta é encerrado automaticamente após 1 hora._"
    );
    // avisar se não tem contato de emergência cadastrado
    const contato = await buscarContato(chatId);
    if (!contato) {
      await enviarMensagem(chatId,
        "⚠️ *Você ainda não tem um contato de emergência cadastrado.*\n\n" +
        "Quando estiver segura, cadastre um número para ser notificado caso você não chegue:\n\n" +
        "/contato 61999999999"
      );
    }
  } else if (tipo === "mulher") {
    await enviarMensagem(chatId, "💜 Relato registrado com segurança. Obrigada por contribuir!");
  } else {
    await enviarMensagem(chatId, "✅ Alerta registrado! A rede foi notificada.");
  }
}

async function notificarCanal(alerta, id) {
  let texto, payload;

  if (alerta.tipo === "sos") {
    texto =
      `🆘🆘🆘 *EMERGÊNCIA — SOS ATIVADO* 🆘🆘🆘\n\n` +
      `📌 ${alerta.descricao}\n` +
      `🕐 ${alerta.hora}\n\n` +
      `⚠️ *ATENÇÃO: alguém precisa de ajuda AGORA*\n` +
      `_Localização registrada no mapa — acesse o painel_`;
    payload = {
      chat_id:      CANAL_ID,
      text:         texto,
      parse_mode:   "Markdown",
      reply_markup: { inline_keyboard: [[
        { text: "📍 Ver no Google Maps",        url: `https://maps.google.com/?q=${alerta.lat},${alerta.lng}` },
        { text: "🗺️ Ver no mapa Escudo Violeta", url: "https://escudo-violeta.pages.dev" }
      ]]}
    };
  } else {
    const emoji = alerta.tipo === "mulher" ? "🟣" : "🔴";
    texto = alerta.tipo === "mulher"
      ? `${emoji} *NOVO RELATO — Espaço Seguro*\n\n📌 ${alerta.descricao}\n🕐 ${alerta.hora}\n\n_Relato anônimo — localização registrada no mapa_`
      : `${emoji} *NOVO ALERTA*\n\n📌 ${alerta.descricao}\n🕐 ${alerta.hora}\n\nVocê está vendo isso agora?`;
    payload = {
      chat_id:    CANAL_ID,
      text:       texto,
      parse_mode: "Markdown"
    };
    if (alerta.tipo !== "mulher") {
      payload.reply_markup = { inline_keyboard: [[
        { text: "✅ Confirmo!",    callback_data: "confirmar_" + id },
        { text: "❌ Não vi nada", callback_data: "negar_"     + id }
      ]]};
    }
  }

  await fetch(`${URL_API}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload)
  });
}

async function processarVoto(cb) {
  const partes = cb.data.split("_");
  const acao   = partes[0];
  const id     = partes[1];
  const url    = URL_FIREBASE + "/" + id + ".json";

  const resp = await fetch(url);
  const data = await resp.json();
  if (!data) return;

  if (acao === "confirmar") {
    data.confirmacoes = (data.confirmacoes || 0) + 1;
    if (data.confirmacoes >= 2) data.status = "confirmado";
  } else {
    data.negacoes = (data.negacoes || 0) + 1;
    if (data.negacoes >= 3) data.status = "descartado";
  }

  await fetch(url, {
    method:  "PUT",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(data)
  });

  await fetch(`${URL_API}/answerCallbackQuery`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      callback_query_id: cb.id,
      text: "👍 Obrigado pelo feedback!"
    })
  });
}

// =====================================================
// FLUXO FEMININO
// =====================================================
const CATEGORIAS = {
  "cat_iluminacao": "🌑 Sem iluminação",
  "cat_deserto":    "🚷 Local ermo ou hostil",
  "cat_assedio":    "😔 Assédio sofrido",
  "cat_seguida":    "👁️ Fui seguida",
  "cat_onibus":     "🚌 Ponto de ônibus perigoso",
  "cat_medo":       "😰 Lugar me deixou com medo"
};

async function mostrarCategorias(chatId) {
  const botoes = { inline_keyboard: [
    [{ text: "🌑 Sem iluminação",           callback_data: "cat_iluminacao" }],
    [{ text: "🚷 Local ermo ou hostil",     callback_data: "cat_deserto"    }],
    [{ text: "😔 Assédio sofrido",          callback_data: "cat_assedio"    }],
    [{ text: "👁️ Fui seguida",              callback_data: "cat_seguida"    }],
    [{ text: "🚌 Ponto de ônibus perigoso", callback_data: "cat_onibus"     }],
    [{ text: "😰 Lugar me deixou com medo", callback_data: "cat_medo"       }]
  ]};
  await enviarMensagem(chatId,
    "💜 Espaço Seguro — São Sebastião DF\n\nO que você quer registrar?\n_(seu nome nunca é guardado)_",
    botoes
  );
}

async function guardarCategoria(cb) {
  const chatId    = cb.from.id;
  const categoria = CATEGORIAS[cb.data] || "Local inseguro";
  cache[chatId]   = { cat: categoria, tipo: "mulher" };

  await fetch(`${URL_API}/answerCallbackQuery`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      callback_query_id: cb.id,
      text: "✅ Categoria registrada!"
    })
  });

  await pedirLocalizacao(chatId, "📌 Agora envie a localização do local que quer registrar:");
}

// =====================================================
// FUNÇÃO AUXILIAR — envia mensagem
// =====================================================
async function enviarMensagem(chatId, texto, teclado) {
  const payload = { chat_id: chatId, text: texto, parse_mode: "Markdown" };
  if (teclado) payload.reply_markup = teclado;
  await fetch(`${URL_API}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload)
  });
}

// =====================================================
// INICIA O SERVIDOR
// =====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  restaurarSOSAtivos();
});
