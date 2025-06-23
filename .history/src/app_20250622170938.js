import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import axios from 'axios'

dotenv.config()

const PORT = process.env.PORT ?? 3008

export const provider = createProvider(Provider, {
  jwtToken: process.env.jwtToken,
  numberId: process.env.numberId,
  verifyToken: process.env.verifyToken,
  version: process.env.version
})

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK']
const negaciones = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO']

const INACTIVITY_MINUTES = 1
const inactivityTimers = new Map()
const reminderCounts = new Map()
const PRE_ENCUESTA = -1

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) clearTimeout(inactivityTimers.get(user))
  if (paso !== null) reminderCounts.delete(`${user}-${paso}`)
}

function scheduleReminder(user, paso, state) {
  clearReminder(user)
  const key = `${user}-${paso}`
  const currentCount = reminderCounts.get(key) || 0
  if (currentCount >= 2) return

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState()
    if (!datos || datos.paso !== paso) return

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(user, '👋 Hola, ¿aún te interesa participar en una breve encuesta? Responde *sí* o *no*.')
      } else {
        await provider.sendText(user, `¿Nos ayudas con la siguiente pregunta ${paso + 1}? 🙏`)
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message)
    }

    reminderCounts.set(key, currentCount + 1)
    scheduleReminder(user, paso, state)
  }, INACTIVITY_MINUTES * 60 * 1000)

  inactivityTimers.set(user, timeoutId)
}

const encuestaFlow = addKeyword(afirmaciones)
  .addAction(async (ctx, { state, flowDynamic }) => {
    clearReminder(ctx.from, PRE_ENCUESTA)
    const { data } = await axios.get('http://localhost:7003/datos-encuesta')
    const { saludos, contactos, preguntas } = data
    const usuario = contactos.find(u => u.num === ctx.from)

    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.')
      return
    }

    const yaInicializado = await state.get('preguntas')
    if (yaInicializado) return

    await state.update({
      preguntas,
      respuestas: [],
      paso: 0,
      nombre: usuario.nombre,
      despedida: saludos[0]?.saludo3 || '✅ Gracias por participar.'
    })

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos.`)
    await flowDynamic(`⿡ ${preguntas[0].pregunta}`)
    scheduleReminder(ctx.from, 0, state)
  })
  .addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from)
    const datos = await state.getMyState()
    if (!datos || !datos.preguntas) return

    let { preguntas, respuestas, paso, despedida } = datos
    const preguntaActual = preguntas[paso]
    const respuesta = ctx.body.trim()

    respuestas.push(respuesta)
    paso++

    if (paso >= preguntas.length) {
      await state.clear()
      const payload = respuestas.map((r, i) => ({
        idContacto: ctx.from,
        idEncuesta: preguntas[i].idEncuesta,
        idEmpresa: preguntas[i].idEmpresa,
        pregunta: preguntas[i].pregunta,
        respuesta: r,
        tipo: preguntas[i].tipoRespuesta,
        idPregunta: preguntas[i].id
      }))
      await axios.post('http://localhost:7003/guardar-respuestas', payload)
      await flowDynamic(despedida)
      return
    }

    await state.update({ preguntas, respuestas, paso, despedida })
    await flowDynamic(`➡️ ${preguntas[paso].pregunta}`)
    scheduleReminder(ctx.from, paso, state)
    return gotoFlow(encuestaFlow)
  })

const negacionFlow = addKeyword(negaciones).addAction(async (ctx, { flowDynamic }) => {
  await flowDynamic('✅ Gracias por tu tiempo. Puedes volver cuando quieras.')
})

const defaultFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { state, flowDynamic }) => {
  const { data } = await axios.get('http://localhost:7003/datos-encuesta')
  const usuario = data.contactos.find(u => u.num === ctx.from)

  if (!usuario) {
    await flowDynamic('❌ No se encontró una encuesta para ti.')
    return
  }

  await state.update({ paso: PRE_ENCUESTA })
  await flowDynamic('👋 ¿Deseas participar en una encuesta breve? Responde sí o no.')
  scheduleReminder(ctx.from, PRE_ENCUESTA, state)
})

// ⬇️ Crear el bot y exportar handleCtx
const adapterFlow = createFlow([encuestaFlow, negacionFlow, defaultFlow])
const adapterDB = new Database()

let handleCtx

const startBot = async () => {
  const bot = await createBot({
    flow: adapterFlow,
    provider,
    database: adapterDB
  })
  handleCtx = bot.handleCtx
}

await startBot()

export { handleCtx }
