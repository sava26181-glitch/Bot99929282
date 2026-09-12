const captchaSolver = require('./captcha_solver');
const signerBridge = require('./signer_bridge');

// ... существующий код 2captcha ...

/**
 * ГИБРИДНЫЙ РЕЖИМ:
 * 1. Пробуем избежать капчи через подпись (SignerPy)
 * 2. Если капча всё же есть — пробуем локальный солвер
 * 3. Фолбэк — 2captcha (если ключ задан)
 */

async function tryAvoidCaptcha() {
  // Подпись запросов — это не функция "решить капчу",
  // а функция "сделать так, чтобы капча не выпала".
  // Используется в фабрике при регистрации.
  return signerBridge;
}

module.exports = {
  // ... старые методы ...
  tryAvoidCaptcha,
  signerBridge
};
