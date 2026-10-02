// Fênix Fono: função que gera textos de leitura com o Claude.
// A chave da API fica no Secret Manager do Firebase, nunca no app.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const CHAVE = defineSecret('ANTHROPIC_API_KEY');

// ===== AJUSTE AQUI =====
const ORIGENS = ['https://SEU-USUARIO.github.io']; // só a origem (sem /pasta)
const MODELO = 'claude-haiku-4-5-20251001';        // rápido e barato para textos curtos
const LIMITE_POR_PESSOA_DIA = 15;                  // textos por pessoa por dia
const LIMITE_TOTAL_DIA = 400;                      // textos no total por dia
const MAX_PALAVRAS = 600;                          // teto por pedido (controla o custo)
// =======================

const limpa = (s, n) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>{}]/g, '').trim().slice(0, n);

// Contador diário no Firestore (coleção "uso", fechada para os clientes pelas regras)
async function conta(id, limite) {
  const ref = db.collection('uso').doc(id);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const n = (s.exists ? s.data().n : 0) + 1;
    if (n > limite) return false;
    t.set(ref, { n, dia: id.slice(0, 10) }, { merge: true });
    return true;
  });
}

exports.gerarTexto = onRequest(
  { region: 'southamerica-east1', secrets: [CHAVE], maxInstances: 5, timeoutSeconds: 60 },
  async (req, res) => {
    const origem = req.headers.origin;
    if (ORIGENS.includes(origem)) {
      res.set('Access-Control-Allow-Origin', origem);
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST' || !ORIGENS.includes(origem)) {
      return res.status(403).json({ erro: 'Acesso não permitido' });
    }

    try {
      const b = req.body || {};
      const palavras = Math.min(MAX_PALAVRAS, Math.max(30, parseInt(b.palavras, 10) || 120));
      const tema = limpa(b.tema, 40);
      const nivel = limpa(b.nivel, 40) || 'Jovem e adulto';
      const tom = limpa(b.tom, 20) || 'Neutro';
      const foco = limpa(b.foco, 80);
      const dificeis = (Array.isArray(b.dificeis) ? b.dificeis : []).slice(0, 10).map((w) => limpa(w, 30)).filter(Boolean);

      // Limites de uso: por pessoa (IP em hash) e total do dia
      const dia = new Date().toISOString().slice(0, 10);
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
      const quem = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
      if (!(await conta(`${dia}_${quem}`, LIMITE_POR_PESSOA_DIA))) {
        return res.status(429).json({ erro: 'Você atingiu o limite de textos de hoje' });
      }
      if (!(await conta(`${dia}_total`, LIMITE_TOTAL_DIA))) {
        return res.status(429).json({ erro: 'Limite diário do serviço atingido. Tente amanhã' });
      }

      const sistema = `Você escreve textos em português do Brasil para treino de leitura em voz alta e de dicção.
Regras:
- Responda SOMENTE com o texto, sem título, sem comentários, sem listas e sem aspas.
- Conteúdo adequado para todas as idades: sem violência, sexo, política partidária, religião, marcas ou pessoas reais.
- Use pontuação clara (vírgulas e pontos) para marcar pausas naturais.
- Escreva cerca de ${palavras} palavras (entre ${Math.round(palavras * 0.9)} e ${Math.round(palavras * 1.1)}).
- Termine sempre em uma frase completa.`;

      const pedido = [
        `Tema: ${tema && tema !== 'Variado' ? tema : 'livre (escolha um tema agradável)'}.`,
        `Nível de leitura: ${nivel}.`,
        `Tom: ${tom}.`,
      ];
      if (foco) pedido.push(`Inclua com naturalidade muitas palavras com estes sons ou deste estilo: ${foco}.`);
      if (dificeis.length) pedido.push(`Use naturalmente estas palavras: ${dificeis.join(', ')}.`);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': CHAVE.value(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODELO,
          max_tokens: Math.min(1800, Math.ceil(palavras * 2.6) + 60),
          system: sistema,
          messages: [{ role: 'user', content: pedido.join('\n') }],
        }),
      });
      if (!r.ok) {
        console.error('Erro da API', r.status, await r.text());
        return res.status(502).json({ erro: 'Serviço de IA indisponível agora' });
      }
      const d = await r.json();
      const texto = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (!texto) return res.status(502).json({ erro: 'Resposta vazia' });
      return res.json({ texto });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ erro: 'Erro interno' });
    }
  }
);
