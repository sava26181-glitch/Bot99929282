function randomComment() {
  const comments = [
    'this is fire 🔥', 'lol', 'so true', 'omg', 'no way',
    'need this', 'who else watching in 2026', 'first',
    'the algorithm blessed me', 'saving this', '😂😂😂',
    'wait what', 'explain', 'tutorial pls', 'goated',
    'im dead 💀', 'bruh', 'fr fr', 'this hits different',
    'lowkey need', 'highkey fire', 'no shot', 'bro what'
  ];
  return comments[Math.floor(Math.random() * comments.length)];
}

function randomKeyword() {
  const words = ['funny', 'cats', 'dance', 'cooking', 'diy', 'gaming',
    'music', 'art', 'nature', 'sports', 'tech', 'business',
    'motivation', 'money', 'travel', 'food'];
  return words[Math.floor(Math.random() * words.length)];
}

class TikTokWarmer {
  constructor(uploader) {
    this.up = uploader;
    this.page = uploader.page;
  }

  async humanDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min) + min);
    await this.page.waitForTimeout(delay);
  }

  async safeClick(selector) {
    try {
      const el = await this.page.$(selector);
      if (el) {
        const box = await el.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await this.page.mouse.click(
            box.x + box.width * (0.3 + Math.random() * 0.4),
            box.y + box.height * (0.3 + Math.random() * 0.4)
          );
          return true;
        }
      }
    } catch {}
    return false;
  }

  async likeRandomVideo() {
    await this.safeClick('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]');
    await this.humanDelay(300, 1000);
  }

  async randomScroll(seconds) {
    const endTime = Date.now() + seconds * 1000;
    let videosWatched = 0;

    while (Date.now() < endTime) {
      const pattern = Math.random();
      if (pattern < 0.6) {
        await this.page.mouse.wheel(0, Math.floor(Math.random() * 600) + 400);
      } else if (pattern < 0.8) {
        await this.page.mouse.wheel(0, Math.floor(Math.random() * 1500) + 800);
        await this.humanDelay(500, 1200);
      } else {
        await this.page.mouse.wheel(0, -Math.floor(Math.random() * 800) - 300);
        await this.humanDelay(2000, 4000);
      }

      const watchTime = Math.random() < 0.7
        ? Math.floor(Math.random() * 5000) + 2000
        : Math.floor(Math.random() * 30000) + 8000;
      await this.page.waitForTimeout(watchTime);
      videosWatched++;

      const action = Math.random();

      if (action < 0.22) {
        await this.likeRandomVideo();
      } else if (action < 0.25 && Math.random() < 0.3) {
        const ok = await this.safeClick('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]');
        if (ok) {
          await this.humanDelay(2000, 4000);
          try {
            await this.page.keyboard.type(randomComment(), { delay: 80 });
            await this.humanDelay(500, 1200);
            await this.page.keyboard.press('Enter');
            await this.humanDelay(1500, 2500);
            await this.page.keyboard.press('Escape');
          } catch {}
        }
      } else if (action < 0.30) {
        const ok = await this.safeClick('[data-e2e="video-author-uniqueid"], [data-e2e="browse-username"]');
        if (ok) {
          await this.humanDelay(3000, 8000);
          await this.page.goBack().catch(() => {});
          await this.humanDelay(1000, 2000);
        }
      } else if (action < 0.32) {
        const ok = await this.safeClick('[data-e2e="share-icon"], [data-e2e="browse-share-icon"]');
        if (ok) {
          await this.humanDelay(1500, 2500);
          await this.page.keyboard.press('Escape');
        }
      }

      if (Math.random() < 0.03) {
        await this.page.goto('https://www.tiktok.com/search?q=' + randomKeyword(), {
          waitUntil: 'domcontentloaded', timeout: 30000
        }).catch(() => {});
        await this.humanDelay(3000, 6000);
      }

      if (Math.random() < 0.1) {
        await this.humanDelay(3000, 8000);
      }
    }

    return videosWatched;
  }

  async warmAccount(days = 3, minutesPerDay = 20) {
    for (let day = 1; day <= days; day++) {
      console.log(`[warm] day ${day}/${days}`);

      try {
        await this.page.goto('https://www.tiktok.com/foryou', {
          waitUntil: 'domcontentloaded', timeout: 60000
        });
        await this.humanDelay(3000, 7000);
        await this.randomScroll(minutesPerDay * 30);
      } catch (e) { console.error('warm morning err:', e.message); }

      try {
        await this.page.goto('https://www.tiktok.com/search?q=' + randomKeyword(), {
          waitUntil: 'domcontentloaded', timeout: 60000
        });
        await this.humanDelay(2000, 5000);
        await this.randomScroll(minutesPerDay * 20);
      } catch (e) { console.error('warm midday err:', e.message); }

      try {
        await this.page.goto('https://www.tiktok.com/foryou', {
          waitUntil: 'domcontentloaded', timeout: 60000
        });
        await this.randomScroll(minutesPerDay * 30);
      } catch (e) { console.error('warm evening err:', e.message); }

      if (day < days) {
        await this.page.waitForTimeout(6 * 60 * 60 * 1000);
      }
    }
  }
}

module.exports = { TikTokWarmer, randomComment, randomKeyword };
