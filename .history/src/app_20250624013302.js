import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { MemoryDB as Database } from '@builderbot/bot';
import { MetaProvider as Provider } from '@builderbot/provider-meta';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const PORT = process.env.PORT ?? 3009;

export const provider = createProvider(Provider, {
  jwtToken: process.env.jwtToken,
  numberId: process.env.numberId,
  verifyToken: process.env.verifyToken,
  version: process.env.version
});

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK'];
const negaciones = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO'];

const INACTIVITY_MINUTES = 0.5;
const inactivityTimers = new Map();
const reminderCounts = new Map();
const PRE_ENCUESTA = -1;

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) {
    clearTimeout(inactivityTimers.get(user));
    inactivityTimers.delete(user);
  }
  if (paso !== null) {
    reminderCounts.delete(${user}-${paso});
  }
}

function scheduleReminder(user, paso, state) {
  clearReminder(user, paso);

  const key = ${user}-${paso};
  const currentCount = reminderCounts.get(key) || 0;
  if (currentCount >= 2) return;

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState();
    if (!datos || datos.paso !== paso) return;

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola, ¿aún te interesa participar en una breve encuesta? Tu opinión es muy importante. Responde sí o no para continuar.'
        );
      } else {
        await provider.sendText(
          user,
          Tu opinión es muy valiosa para nosotros 🙏, ¿podrías ayudarnos respondiendo la pregunta ${paso + 1}?
        );
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message);
    }

    reminderCounts.set(key, currentCount + 1);
    scheduleReminder(user, paso, state);
  }, INACTIVITY_MINUTES * 60 * 1000);

  inactivityTimers.set(user, timeoutId);
}
