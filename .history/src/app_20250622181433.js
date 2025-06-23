import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import axios from 'axios'
dotenv.config()

const PORT = process.env.PORT ?? 3008

// Inicializa el proveedor de Meta (WhatsApp)
export const provider = createProvider(Provider, {
  jwtToken: process.env.jwtToken,
  numberId: process.env.numberId,
  verifyToken: process.env.verifyToken,
  version: process.env.version
})

// Tus flujos y lógica de encuesta...
const afirmaciones = ['SI','SÍ','CLARO','DALE','LISTO','ACEPTO','VOY','DE UNA','OK']
const negaciones    = ['NO','NO GRACIAS','NUNCA','NEGADO','AHORA NO','NO DESEARÍA','PASO']
const INACTIVITY_MINUTES = 1
const inactivityTimers   = new Map()
const reminderCounts     = new Map()
const PRE_ENCUESTA       = -1

function clearReminder(user, paso = null) { /* ... */ }
function scheduleReminder(user, paso, state) { /* ... */ }

// Flow “sí” inicia encuesta:
const encuestaFlow = addKeyword(afirmaciones)
  .addAction(async (ctx, { state, flowDynamic }) => { /* carga preguntas, saludo, etc. */ })
  .addAnswer( null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => { /* guarda respuestas... */ })

// Flow “no” cancela:
const negacionFlow = addKeyword(negaciones)
  .addAction(async (ctx, { flowDynamic, state }) => { /* agradece y termina */ })

// Flow por defecto (Events.WELCOME)
const defaultFlow = addKeyword(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic, state }) => {
    /* mensaje inicial “¿Quieres participar?” */
    scheduleReminder(ctx.from, PRE_ENCUESTA, state)
  })

// Arranca el bot:
const main = async () => {
  const adapterFlow = createFlow([ encuestaFlow, negacionFlow, defaultFlow ])
  const adapterDB   = new Database()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider,
    database: adapterDB
  })

  // Verificación mínima de endpoint:
  provider.server.get('/v1/prueba', (req, res) => {
    res.writeHead(200, {'Content-Type':'text/plain'})
    res.end('✅ Ruta activa: /v1/prueba (GET)')
  })

  httpServer(+PORT)
  console.log(`🤖 Builderbot escuchando en puerto ${PORT}`)
}

main()
