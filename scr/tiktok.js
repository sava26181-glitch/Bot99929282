const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const PROFILE_DIR = path.join(DATA_DIR, "tiktok-profile");
fs.mkdirSync(PROFILE_DIR, { recursive: true });

let context = null;
let page = null;

async function browser() {
  if (context) return context;

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: String(process.env.HEADLESS || "true").toLowerCase() === "true",
    viewport: { width: 1280, height: 900 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });

  context.on("close", () => {
    context = null;
    page = null;
  });

  page = context.pages()[0] || await context.newPage();
  return context;
}

async function getPage() {
  const ctx = await browser();
  page = ctx.pages()[0] || await ctx.newPage();
  return page;
}

async function gotoTikTok(pathname = "/") {
  const p = await getPage();
  await p.goto("https://www.tiktok.com" + pathname, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }).catch(() => {});
  await p.waitForTimeout(2000);
  return p;
}

async function openLogin() {
  return gotoTikTok("/login");
}

async function openProfile() {
  return gotoTikTok("/profile");
}

async function clickEditProfile(p) {
  const candidates = [
    p.getByRole("button", { name: /Edit profile|Редактировать профиль/i }).first(),
    p.getByText(/Edit profile|Редактировать профиль/i).first()
  ];

  for (const loc of candidates) {
    try {
      if (await loc.isVisible({ timeout: 2500 })) {
        await loc.click();
        await p.waitForTimeout(1000);
        return true;
      }
    } catch {}
  }
  return false;
}

async function setBio(value) {
  const p = await openProfile();

  if (!(await clickEditProfile(p))) {
    throw new Error("Кнопка редактирования профиля не найдена.");
  }

  const selectors = [
    'textarea[placeholder*="Bio" i]',
    'textarea[placeholder*="Био" i]',
    'textarea'
  ];

  let field;
  for (const selector of selectors) {
    try {
      const loc = p.locator(selector).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        field = loc;
        break;
      }
    } catch {}
  }

  if (!field) throw new Error("Поле био не найдено.");

  await field.fill(value);

  const save = p.getByRole("button", { name: /Save|Сохранить/i }).first();
  if (!(await save.isVisible({ timeout: 2500 }).catch(() => false))) {
    throw new Error("Кнопка сохранения не найдена.");
  }

  await save.click();
  await p.waitForTimeout(1500);
}

async function setName(value) {
  const p = await openProfile();

  if (!(await clickEditProfile(p))) {
    throw new Error("Кнопка редактирования профиля не найдена.");
  }

  const selectors = [
    'input[placeholder*="Name" i]',
    'input[placeholder*="Имя" i]',
    'input[name*="name" i]'
  ];

  let field;
  for (const selector of selectors) {
    try {
      const loc = p.locator(selector).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        field = loc;
        break;
      }
    } catch {}
  }

  if (!field) throw new Error("Поле имени не найдено.");

  await field.fill(value);

  const save = p.getByRole("button", { name: /Save|Сохранить/i }).first();
  if (!(await save.isVisible({ timeout: 2500 }).catch(() => false))) {
    throw new Error("Кнопка сохранения не найдена.");
  }

  await save.click();
  await p.waitForTimeout(1500);
}

async function setAvatar(filePath) {
  const p = await openProfile();

  if (!(await clickEditProfile(p))) {
    throw new Error("Кнопка редактирования профиля не найдена.");
  }

  const inputs = p.locator('input[type="file"]');
  const count = await inputs.count();

  if (!count) {
    throw new Error("Поле загрузки аватара не найдено.");
  }

  await inputs.first().setInputFiles(filePath);
  await p.waitForTimeout(1500);

  const save = p.getByRole("button", {
    name: /Save|Сохранить|Confirm|Подтвердить/i
  }).first();

  if (await save.isVisible({ timeout: 3000 }).catch(() => false)) {
    await save.click();
  }

  await p.waitForTimeout(2000);
}

async function close() {
  if (context) await context.close();
  context = null;
  page = null;
}

async function clearSession() {
  await close();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

module.exports = {
  browser,
  getPage,
  openLogin,
  openProfile,
  setBio,
  setName,
  setAvatar,
  close,
  clearSession
};
