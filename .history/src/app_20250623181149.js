import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database }                                      from '@builderbot/bot'
import { MetaProvider as Provider }                                  from '@builderbot/provider-meta'
import dotenv                                                        from 'dotenv'
import axios                                                         from 'axios'
dotenv.config()

const PORT               = process.env.PORT ?? 3008
const INACTIVITY_MINUTES = 1
const PRE_ENCUESTA       = -1

const inactivityTimers = new Map()
const reminderCounts   = new Map()

export const provider = createProvider(Provider, {
  jwtToken:    process.env.jwtToken,
  numberId:    process.env.numberId,
  verifyToken: process.env.verifyToken,
  version:     process.env.version
})

const afirmaciones = ['SI','SÍ','CLARO','DALE','LISTO','ACEPTO','VOY','DE UNA','OK']
const negaciones    = ['NO','NO GRACIAS','NUNCA','NEGADO','AHORA NO','NO DESEARÍA','PASO']

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
  if (currentCount >= 2) return

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState()
    if (!datos || datos.paso !== paso) return

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola de nuevo, ¿aún quieres la encuesta? Responde *sí* o *no*.'
        )
      } else {
        await provider.sendText(
          user,
          `🙏 ¿Podrías responder la pregunta ${paso + 1}, por favor?`
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

// 1) Saludo inicial
const defaultFlow = addKeyword(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic, state }) => {
    await state.clear()
    await state.update({ paso: PRE_ENCUESTA })
    await flowDynamic(
      '👋 ¡Hola! ¿Deseas participar en una breve encuesta? Responde *sí* o *no*.'
    )
    scheduleReminder(ctx.from, PRE_ENCUESTA, state)
  })

// 2) Confirmación sí/no
const confirmFlow = addKeyword([...afirmaciones, ...negaciones])
  .addAction(async (ctx, { state, flowDynamic }) => {
    const pasoActual = await state.get('paso')
    if (pasoActual !== PRE_ENCUESTA) return

    clearReminder(ctx.from, PRE_ENCUESTA)

    const { data }      = await axios.get('http://localhost:7003/datos-encuesta')
    const { saludos, contactos, preguntas } = data
    const numeroLimpio  = ctx.from.replace(/@c\.us$/i, '')
    const usuario       = contactos.find(u => String(u.num) === numeroLimpio)

    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.')
      return
    }

    if (negaciones.includes(ctx.body.trim().toUpperCase())) {
      await state.clear()
      await flowDynamic('✅ Gracias por tu tiempo. ¡Cuando quieras, me avisas!')
      return
    }

    // arranca encuesta
    await state.update({
      preguntas:  preguntas,
      respuestas: [],
      paso:       0,
      nombre:     usuario.nombre,
      despedida:  saludos[0]?.saludo3 ?? '✅ Gracias por participar.'
    })

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos:`)
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

// 3) Captura de respuestas (RANGO o CONFIRMA)
//     Ahora con array de RegExp para cumplir la firma requerida:
const surveyFlow = addKeyword([/.*/], { capture: true })
  .addAction(async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from)
    const datos = await state.getMyState()
    if (!datos || typeof datos.paso !== 'number' || datos.paso < 0) return

    let { preguntas, respuestas, paso, despedida } = datos
    const actual = preguntas[paso]
    const resp   = ctx.body.trim()

    if (actual.tipoRespuesta === 'RANGO') {
      const val = parseInt(resp, 10)
      if (isNaN(val) || val < actual.rangoIni || val > actual.rangoFin) {
        await flowDynamic(
          `❌ Responde un número entre ${actual.rangoIni} y ${actual.rangoFin}.`
        )
        return gotoFlow(surveyFlow)
      }
    } else if (actual.tipoRespuesta === 'CONFIRMA') {
      const ok = ['SI','SÍ','NO']
      if (!ok.includes(resp.toUpperCase())) {
        await flowDynamic('❌ Solo "SI" o "NO", por favor.')
        return gotoFlow(surveyFlow)
      }
    }

    respuestas.push(resp)
    paso++

    if (paso >= preguntas.length) {
      await state.clear()
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
        console.error(e)
        await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.')
      }

      await flowDynamic(despedida)
      const resumen = respuestas
        .map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`)
        .join('\n\n')
      return await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`)
    }

    // siguiente pregunta
    const sigu = preguntas[paso]
    let msg  = `${paso + 1}⃣ ${sigu.pregunta}`
    if (sigu.textoIni && sigu.tipoRespuesta === 'RANGO') {
      msg += `\n*Califica del ${sigu.rangoIni} al ${sigu.rangoFin}*`
      msg += '\n' + sigu.textoIni
        .split('=')
        .map(s => s.replace('-', ' – ').trim())
        .join('\n')
    } else if (sigu.textoIni) {
      msg += '\n' + sigu.textoIni
        .split('=')
        .map(s => s.replace('-', ' – ').trim())
        .join('\n')
    }

    await state.update({ preguntas, respuestas, paso, despedida })
    await flowDynamic(msg)
    scheduleReminder(ctx.from, paso, state)
    return gotoFlow(surveyFlow)
  })

// 4) Arrancamos el bot
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
