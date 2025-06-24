'use strict';

const {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS
} = require('@builderbot/bot');
const { MemoryDB: Database }      = require('@builderbot/bot');
const { MetaProvider: Provider }  = require('@builderbot/provider-meta');
const dotenv                      = require('dotenv');
const axios                       = require('axios');
dotenv.config();

const PORT               = process.env.PORT ?? 3009;
const INACTIVITY_MINUTES = 0.5;
const PRE_ENCUESTA       = -1;

const inactivityTimers = new Map();
const reminderCounts   = new Map();

const provider = createProvider(Provider, {
  jwtToken:    process.env.jwtToken,
  numberId:    process.env.numberId,
  verifyToken: process.env.verifyToken,
  version:     process.env.version
});

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK'];
const negaciones    = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO'];

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) {
    clearTimeout(inactivityTimers.get(user));
    inactivityTimers.delete(user);
  }
  if (paso !== null) {
    reminderCounts.delete(`${user}-${paso}`);
  }
}

function scheduleReminder(user, paso, state) {
  clearReminder(user, paso);

  const key          = `${user}-${paso}`;
  const currentCount = reminderCounts.get(key) || 0;
  if (currentCount >= 2) return;

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState();
    if (!datos || datos.paso !== paso) return;

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola, ¿aún te interesa participar en una breve encuesta? Tu opinión es muy importante. Responde *sí* o *no* para continuar.'
        );
      } else {
        await provider.sendText(
          user,
          `🙏 Tu opinión es muy valiosa para nosotros. ¿Podrías ayudarnos respondiendo la pregunta ${paso + 1}?`
        );
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message);
    }

    reminderCounts.set(key, currentCount + 1);
    scheduleReminder(user, paso, state);
  }, INACTIVITY_MINUTES * 60 * 1000);

  inactivityTimers.set(user, timeoutId);
}

// ─── Flujo de encuesta ─────────────────────────────────────────────────────
const encuestaFlow = addKeyword(afirmaciones)
  .addAction(async (ctx, { state, flowDynamic }) => {
    clearReminder(ctx.from, PRE_ENCUESTA);

    const { data } = await axios.get('http://localhost:7003/datos-encuesta');
    const { saludos, contactos, preguntas } = data;

    const numeroLimpio = ctx.from.replace(/@c\.us$/i, '');
    const usuario      = contactos.find(u => String(u.num) === numeroLimpio);

    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.');
      return;
    }

    const yaInit = await state.get('preguntas');
    if (yaInit) return;

    await state.update({
      preguntas:  preguntas,
      respuestas: [],
      paso:       0,
      nombre:     usuario.nombre,
      despedida:  saludos[0]?.saludo3 || '✅ Gracias por participar en la encuesta.'
    });

    // Saludo personalizado
    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos con tu encuesta.`);

    // Primera pregunta
    const p0   = preguntas[0];
    let msg0   = `⿡ ${p0.pregunta}`;

    if (p0.textoIni && p0.tipoRespuesta === 'RANGO') {
      msg0 += `\n*Califica del rango ${p0.rangoIni} al ${p0.rangoFin}*`;
      msg0 += `\n${p0.textoIni
        .split('=')
        .map(s => s.replace('-', ' - ').trim())
        .join('\n')}`;
    } else if (p0.textoIni) {
      msg0 += `\n${p0.textoIni
        .split('=')
        .map(s => s.replace('-', ' - ').trim())
        .join('\n')}`;
    }

    await flowDynamic(msg0);
    scheduleReminder(ctx.from, 0, state);
  })
  .addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from);

    const datos = await state.getMyState();
    if (!datos || !datos.preguntas) return;

    let { preguntas, respuestas, paso, despedida } = datos;
    const actual = preguntas[paso];
    const resp   = ctx.body.trim();

    // Validación de RANGO
    if (actual.tipoRespuesta === 'RANGO') {
      const val = parseInt(resp, 10);
      if (isNaN(val) || val < actual.rangoIni || val > actual.rangoFin) {
        await flowDynamic(
          `❌ Por favor responde con un número entre ${actual.rangoIni} y ${actual.rangoFin}.`
        );
        return gotoFlow(encuestaFlow);
      }
    }
    // Validación de CONFIRMA
    else if (actual.tipoRespuesta === 'CONFIRMA') {
      const ok = ['SI','SÍ','NO'];
      if (!ok.includes(resp.toUpperCase())) {
        await flowDynamic('❌ Responde sólo con "SI" o "NO".');
        return gotoFlow(encuestaFlow);
      }
    }

    respuestas.push(resp);
    paso++;

    // Fin de encuesta
    if (paso >= preguntas.length) {
      await state.clear();

      // Construye resumen
      const resumen = respuestas
        .map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`)
        .join('\n\n');

      // Payload para API
      const payload = preguntas.map((p, i) => ({
        idContacto: ctx.from,
        idEncuesta: p.idEncuesta,
        idEmpresa:  p.idEmpresa,
        pregunta:   p.pregunta,
        respuesta:  respuestas[i],
        tipo:       p.tipoRespuesta,
        idPregunta: p.id
      }));

      console.log('📦 Payload de respuestas:', payload);

      try {
        await axios.post('http://localhost:7003/guardar-respuestas', payload);
        await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.');

        // Marca fin de encuesta
        await axios.post('http://localhost:7003/finalizar-encuesta', {
          idContacto: ctx.from,
          idEncuesta: preguntas[0].idEncuesta
        });
        console.log('✅ Encuesta finalizada en backend.');
      } catch (e) {
        console.error('Error al guardar/finalizar encuesta:', e.message);
        await flowDynamic('⚠ Hubo un problema al guardar tus respuestas o cerrar la encuesta.');
      }

      await flowDynamic(despedida);
      await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`);
      return await flowDynamic('🎉 ¡Encuesta finalizada! Muchas gracias por tu tiempo y tu opinión.');
    }

    // Siguiente pregunta
    const sig = preguntas[paso];
    let msg = `${paso + 1}⃣ ${sig.pregunta}`;

    if (sig.textoIni && sig.tipoRespuesta === 'RANGO') {
      msg += `\n*Califica del rango ${sig.rangoIni} al ${sig.rangoFin}*`;
      msg += `\n${sig.textoIni
        .split('=')
        .map(s => s.replace('-', ' - ').trim())
        .join('\n')}`;
    } else if (sig.textoIni) {
      msg += `\n${sig.textoIni
        .split('=')
        .map(s => s.replace('-', ' - ').trim())
        .join('\n')}`;
    }

    await state.update({ preguntas, respuestas, paso, despedida });
    await flowDynamic(msg);
    scheduleReminder(ctx.from, paso, state);
    return gotoFlow(encuestaFlow);
  });

// ─── Flujo de negaciones ───────────────────────────────────────────────────
const negacionFlow = addKeyword(negaciones)
  .addAction(async (ctx, { flowDynamic, state }) => {
    clearReminder(ctx.from);
    const { data } = await axios.get('http://localhost:7003/datos-encuesta');
    const { contactos } = data;
    const num       = ctx.from.replace(/@c\.us$/i, '');
    const usuario   = contactos.find(u => String(u.num) === num);

    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.');
      return;
    }
    await state.clear();
    await flowDynamic('✅ Gracias por tu tiempo. Si deseas participar en otro momento, estaré disponible.');
  });

// ─── Flujo de bienvenida (WELCOME) ─────────────────────────────────────────
const defaultFlow = addKeyword([EVENTS.WELCOME])
  .addAction(async (ctx, { flowDynamic, state }) => {
    await state.clear();
    await state.update({ paso: PRE_ENCUESTA });
    await flowDynamic('👋 ¡Hola! ¿Deseas participar en una breve encuesta? Responde *sí* o *no* para continuar.');
    console.log(`🕒 Programando recordatorio para ${ctx.from}, paso ${PRE_ENCUESTA}`);
    scheduleReminder(ctx.from, PRE_ENCUESTA, state);
  });

// ─── Arranque del bot ───────────────────────────────────────────────────────
async function main() {
  const adapterFlow = createFlow([ encuestaFlow, negacionFlow, defaultFlow ]);
  const adapterDB   = new Database();
  const { httpServer } = await createBot({
    flow:     adapterFlow,
    provider,
    database: adapterDB
  });
  httpServer(+PORT);
}

main();
