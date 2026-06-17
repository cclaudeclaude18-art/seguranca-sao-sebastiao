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

// =====================================================
// PING — mantém o servidor acordado
// =====================================================
app.get("/ping", (req, res) => res.send("ok"));

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

  await enviarMensagem(chatId,
    "👋 Olá! Bem-vindo à Rede de Segurança de São Sebastião — DF.\n\n" +
    "🚨 Use /alerta para reportar algo suspeito.\n" +
    "   Ex: /alerta Carro parado há horas\n\n" +
    "🚺 Use /registrar para o Espaço Seguro das Mulheres."
  );
});

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

  const msg = tipo === "mulher"
    ? "💜 Relato registrado com segurança. Obrigada por contribuir!"
    : tipo === "sos"
      ? "🆘 SOS registrado! A rede foi alertada. Fique segura — ajuda a caminho."
      : "✅ Alerta registrado! A rede foi notificada.";
  await enviarMensagem(chatId, msg);
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
      chat_id:    CANAL_ID,
      text:       texto,
      parse_mode: "Markdown"
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
  "cat_sos":        "🆘 Preciso de ajuda AGORA"
};

async function mostrarCategorias(chatId) {
  const botoes = { inline_keyboard: [
    [{ text: "🌑 Sem iluminação",         callback_data: "cat_iluminacao" }],
    [{ text: "🚷 Local ermo ou hostil",   callback_data: "cat_deserto"    }],
    [{ text: "😔 Assédio sofrido",        callback_data: "cat_assedio"    }],
    [{ text: "🆘 Preciso de ajuda AGORA", callback_data: "cat_sos"        }]
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
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
