import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import axios from 'axios'
dotenv.config()

const PORT = process.env.PORT ?? 3008

export const provider = createProvider(Provider, {
  jwtToken:   process.env.jwtToken,
  numberId:   process.env.numberId,
  verifyToken: process.env.verifyToken,
  version:    process.env.version
})

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK']
const negaciones    = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO']

const INACTIVITY_MINUTES = 1
const inactivityTimers    = new Map()
const reminderCounts      = new Map()
const PRE_ENCUESTA        = -1  // paso de confirmación

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) {
    clearTimeout(inactivityTimers.get(user))
    inactivityTimers.delete(user)
  }
  if (paso !== null) {
    reminderCounts.delete(`${user}-${paso}`)
  }
}

function scheduleReminder(user, paso, state) {
  clearReminder(user, paso)

  const key          = `${user}-${paso}`
  const currentCount = reminderCounts.get(key) || 0
  if (currentCount >= 2) return // máximo 2 recordatorios

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState()
    if (!datos || datos.paso !== paso) return

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola de nuevo, ¿aún te interesa participar en la encuesta? Responde *sí* o *no*.'
        )
      } else {
        await provider.sendText(
          user,
          `🙏 Te agradeceríamos que respondieras la pregunta ${paso + 1}.`
        )
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message)
    }

    reminderCounts.set(key, currentCount + 1)
    scheduleReminder(user, paso, state)
  }, INACTIVITY_MINUTES * 60 * 1000)

  inactivityTimers.set(user, timeoutId)
}

// ──────────────────────────────────────────────────────────────────────────────
// 1) defaultFlow: saludo inicial y paso = PRE_ENCUESTA
// ──────────────────────────────────────────────────────────────────────────────
const defaultFlow = addKeyword(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic, state }) => {
    await state.clear()
    await state.update({ paso: PRE_ENCUESTA })
    await flowDynamic(
      '👋 ¡Hola! ¿Deseas participar en una breve encuesta? Responde *sí* o *no* para continuar.'
    )
    scheduleReminder(ctx.from, PRE_ENCUESTA, state)
  })

// ──────────────────────────────────────────────────────────────────────────────
// 2) confirmFlow: maneja SI / NO antes de empezar
// ──────────────────────────────────────────────────────────────────────────────
const confirmFlow = addKeyword([...afirmaciones, ...negaciones])
  .addAction(async (ctx, { state, flowDynamic }) => {
    const pasoActual = await state.get('paso')
    if (pasoActual !== PRE_ENCUESTA) {
      // no estamos en etapa de confirmación → ignorar
      return
    }

    // limpia cualquier recordatorio pendiente de confirmación
    clearReminder(ctx.from, PRE_ENCUESTA)

    const { data } = await axios.get('http://localhost:7003/datos-encuesta')
    const { saludos, contactos, preguntas } = data

    // normalizamos ctx.from quitando "@c.us" si existe
    const numeroLimpio = ctx.from.replace(/@c\.us$/i, '')
    const usuario      = contactos.find(u => String(u.num) === numeroLimpio)

    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.')
      return
    }

    // si el usuario dijo NO:
    if (negaciones.includes(ctx.body.trim().toUpperCase())) {
      await state.clear()
      await flowDynamic('✅ Gracias por tu tiempo. ¡Cuando quieras otra encuesta, me avisas!')
      return
    }

    // si dijo SI, arrancamos la encuesta
    await state.update({
      preguntas:  preguntas,
      respuestas: [],
      paso:       0,
      nombre:     usuario.nombre,
      despedida:  saludos[0]?.saludo3 ?? '✅ Gracias por participar en la encuesta.'
    })

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos:`)

    // enviamos la primera pregunta
    const p0 = preguntas[0]
    let msg0 = `1⃣ ${p0.pregunta}`

    if (p0.textoIni && p0.tipoRespuesta === 'RANGO') {
      msg0 += `\n*Califica del ${p0.rangoIni} al ${p0.rangoFin}*`
      msg0 += '\n' + p0.textoIni
        .split('=')
        .map(s => s.replace('-', ' – ').trim())
        .join('\n')
    } else if (p0.textoIni) {
      msg0 += '\n' + p0.textoIni
        .split('=')
        .map(s => s.replace('-', ' – ').trim())
        .join('\n')
    }

    await flowDynamic(msg0)
    scheduleReminder(ctx.from, 0, state)
  })

// ──────────────────────────────────────────────────────────────────────────────
// 3) surveyFlow: captura todas las respuestas (RANGO o CONFIRMA)
// ──────────────────────────────────────────────────────────────────────────────
const surveyFlow = addKeyword(null, { capture: true })
  .addAction(async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from)
    const datos = await state.getMyState()
    if (!datos || typeof datos.paso !== 'number' || datos.paso < 0) {
      // aún no hemos arrancado la encuesta → ignorar
      return
    }

    let { preguntas, respuestas, paso, despedida } = datos
    const preguntaActual = preguntas[paso]
    const respuesta      = ctx.body.trim()

    // validación de RANGO
    if (preguntaActual.tipoRespuesta === 'RANGO') {
      const valor = parseInt(respuesta, 10)
      if (
        isNaN(valor) ||
        valor < preguntaActual.rangoIni ||
        valor > preguntaActual.rangoFin
      ) {
        await flowDynamic(
          `❌ Por favor responde con un número entre ${preguntaActual.rangoIni} y ${preguntaActual.rangoFin}.`
        )
        return gotoFlow(surveyFlow)
      }
    }
    // validación de CONFIRMA
    else if (preguntaActual.tipoRespuesta === 'CONFIRMA') {
      const ok = ['SI', 'SÍ', 'NO']
      if (!ok.includes(respuesta.toUpperCase())) {
        await flowDynamic('❌ Responde solo con "SI" o "NO".')
        return gotoFlow(surveyFlow)
      }
    }

    // si pasa validación, guardamos y avanzamos:
    respuestas.push(respuesta)
    paso++

    // ── si ya no quedan preguntas, terminamos:
    if (paso >= preguntas.length) {
      await state.clear()

      // 1) intentamos guardar en tu API
      const payload = preguntas.map((p, i) => ({
        idContacto: ctx.from,
        idEncuesta: p.idEncuesta,
        idEmpresa:  p.idEmpresa,
        pregunta:   p.pregunta,
        respuesta:  respuestas[i],
        tipo:       p.tipoRespuesta,
        idPregunta: p.id
      }))

      try {
        await axios.post('http://localhost:7003/guardar-respuestas', payload)
        await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.')
      } catch (e) {
        console.error('Error al guardar respuestas:', e.message)
        await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.')
      }

      // 2) despedida y resumen
      await flowDynamic(despedida)
      const resumen = respuestas
        .map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`)
        .join('\n\n')
      return await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`)
    }

    // ── si quedan más, enviamos la siguiente:
    const siguiente = preguntas[paso]
    let msg        = `${paso + 1}⃣ ${siguiente.pregunta}`

    if (siguiente.textoIni && siguiente.tipoRespuesta === 'RANGO') {
      msg += `\n*Califica del ${siguiente.rangoIni} al ${siguiente.rangoFin}*`
      msg += '\n' + siguiente.textoIni
        .split('=')
        .map(s => s.replace('-', ' – ').trim())
        .join('\n')
    } else if (siguiente.textoIni) {
      msg += '\n' + siguiente.textoIni
        .split('=')
        .map(s => s.replace('-', ' – ').trim())
        .join('\n')
    }

    await state.update({ preguntas, respuestas, paso, despedida })
    await flowDynamic(msg)
    scheduleReminder(ctx.from, paso, state)
    return gotoFlow(surveyFlow)
  })

// ──────────────────────────────────────────────────────────────────────────────
// 4) construimos el bot con todos los flows
// ──────────────────────────────────────────────────────────────────────────────
const main = async () => {
  const adapterFlow = createFlow([ defaultFlow, confirmFlow, surveyFlow ])
  const adapterDB   = new Database()

  const { httpServer } = await createBot({
    flow:     adapterFlow,
    provider,
    database: adapterDB
  })

  httpServer(+PORT)
}

main()
