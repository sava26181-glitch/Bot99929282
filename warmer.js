const crypto = require('crypto');

/* ============================================================
 *  КОНСТАНТЫ ПОВЕДЕНИЯ
 * ============================================================ */

const COMMENT_POOL = [
  'this is fire 🔥', 'lol', 'so true', 'omg', 'no way',
  'need this', 'who else watching in 2026', 'first',
  'the algorithm blessed me', 'saving this', '😂😂😂',
  'wait what', 'explain', 'tutorial pls', 'goated',
  'im dead 💀', 'bruh', 'fr fr', 'this hits different',
  'lowkey need', 'highkey fire', 'no shot', 'bro what',
  'sheeeesh', 'underrated', 'cant stop watching'
];

const SEARCH_KEYWORDS = [
  'funny', 'cats', 'dance', 'cooking', 'diy', 'gaming',
  'music', 'art', 'nature', 'sports', 'tech', 'business',
  'motivation', 'money', 'travel', 'food', 'fitness',
  'fashion', 'beauty', 'cars', 'animals', 'comedy'
];

const REGIONS = ['US', 'GB', 'CA', 'AU'];

/* ============================================================
 *  УТИЛИТЫ
 * ============================================================ */

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function humanDelay(minMs, maxMs) {
  return new Promise(r => setTimeout(r, randInt(minMs, maxMs)));
}

function randomComment() {
  return pick(COMMENT_POOL);
}

function randomKeyword() {
  return pick(SEARCH_KEYWORDS);
}

/* ============================================================
 *  WARMER
 * ============================================================ */

class TikTokMobileWarmer {
  constructor(api) {
    // api — это экземпляр TikTokMobile из tiktok_uploader.js
    this.api = api;
    this.stats = {
      feeds: 0,
      views: 0,
      likes: 0,
      comments: 0,
      follows: 0,
      searches: 0,
      shares: 0
    };
  }

  /**
   * Получить ленту видео.
   * count — сколько видео вернуть (обычно 6).
   * type — 0 = For You, 1 = Following.
   */
  async fetchFeed(count = 6, type = 0) {
    try {
      const result = await this.api.signedRequest('/aweme/v1/feed/', {
        count,
        type,
        feed_style: 2,
        pull_type: 0,
        max_cursor: 0,
        min_cursor: 0
      });
      this.stats.feeds++;
      return result.aweme_list || [];
    } catch (e) {
      console.error('[warmer] feed error:', e.message);
      return [];
    }
  }

  /**
   * "Просмотр" видео — запрашиваем статистику + задержка.
   * TikTok считает просмотр когда приходит запрос на stats.
   */
  async viewVideo(aweme, durationMs) {
    try {
      // Heartbeat: stats запрос
      await this.api.signedRequest('/aweme/v1/aweme/stats/', {
        aweme_id: aweme.aweme_id,
        play_delta: Math.floor(durationMs / 1000),
        item_type: 0
      });
      this.stats.views++;
    } catch (e) {
      // Молча — TikTok часто возвращает пустое тело
    }
    await humanDelay(durationMs, durationMs + 1000);
  }

  /**
   * Лайк видео.
   */
  async likeVideo(aweme) {
    try {
      await this.api.signedRequest('/aweme/v1/commit/item/digg/', {
        aweme_id: aweme.aweme_id,
        type: 1
      });
      this.stats.likes++;
      return true;
    } catch (e) {
      console.error('[warmer] like error:', e.message);
      return false;
    }
  }

  /**
   * Снять лайк (редко, для реализма).
   */
  async unlikeVideo(aweme) {
    try {
      await this.api.signedRequest('/aweme/v1/commit/item/digg/', {
        aweme_id: aweme.aweme_id,
        type: 0
      });
    } catch {}
  }

  /**
   * Комментарий к видео.
   */
  async commentVideo(aweme, text) {
    try {
      await this.api.signedRequest('/aweme/v1/comment/publish/', {
        aweme_id: aweme.aweme_id,
        text: text || randomComment(),
        comment_id: 0,
        text_extra: '[]'
      });
      this.stats.comments++;
      return true;
    } catch (e) {
      console.error('[warmer] comment error:', e.message);
      return false;
    }
  }

  /**
   * Подписка на автора.
   */
  async followUser(aweme) {
    const uid = aweme.author?.uid;
    if (!uid) return false;
    try {
      await this.api.signedRequest('/aweme/v1/commit/follow/user/', {
        user_id: uid,
        type: 1,
        sec_user_id: aweme.author?.sec_uid || ''
      });
      this.stats.follows++;
      return true;
    } catch (e) {
      console.error('[warmer] follow error:', e.message);
      return false;
    }
  }

  /**
   * Шеринг видео (внутренний — сохранить в избранное).
   */
  async shareVideo(aweme) {
    try {
      await this.api.signedRequest('/aweme/v1/aweme/collect/', {
        aweme_id: aweme.aweme_id,
        action: 1
      });
      this.stats.shares++;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Поиск по ключевому слову.
   */
  async search(keyword) {
    try {
      const result = await this.api.signedRequest('/aweme/v1/search/item/', {
        keyword: keyword || randomKeyword(),
        count: 10,
        offset: 0,
        search_source: 'normal_search',
        hot_search: 0
      });
      this.stats.searches++;
      return result.aweme_list || result.data || [];
    } catch (e) {
      console.error('[warmer] search error:', e.message);
      return [];
    }
  }

  /**
   * Одна сессия просмотра ленты.
   * Длится `seconds` секунд, дёргает ленту и делает действия.
   */
  async scrollSession(seconds) {
    const endTime = Date.now() + seconds * 1000;
    let videosWatched = 0;

    while (Date.now() < endTime) {
      // Получаем пачку видео
      const feed = await this.fetchFeed(6, 0);
      if (!feed.length) {
        await humanDelay(3000, 6000);
        continue;
      }

      for (const aweme of feed) {
        if (Date.now() >= endTime) break;
        if (!aweme?.aweme_id) continue;

        // Смотрим видео — время зависит от длины видео
        const videoDuration = (aweme.video?.duration || 5000);
        // Смотрим 60-100% длины, но не больше 30 сек
        const watchRatio = 0.6 + Math.random() * 0.4;
        const watchTime = Math.min(
          Math.floor(videoDuration * watchRatio),
          30000
        );

        await this.viewVideo(aweme, watchTime);
        videosWatched++;

        // Действия с вероятностями
        const action = Math.random();

        if (action < 0.22) {
          // Лайк
          await this.likeVideo(aweme);
          await humanDelay(800, 2000);
        } else if (action < 0.25 && Math.random() < 0.3) {
          // Комментарий (редко)
          await this.commentVideo(aweme, randomComment());
          await humanDelay(2000, 4000);
        } else if (action < 0.28) {
          // Подписка
          await this.followUser(aweme);
          await humanDelay(1500, 3000);
        } else if (action < 0.30) {
          // Сохранить
          await this.shareVideo(aweme);
          await humanDelay(800, 1500);
        }

        // Иногда «залипаем» — долгая пауза
        if (Math.random() < 0.  1) {
          await humanDelay(5000, * 12000);
        minutes }

        // Микро-пауза междуPer видео
        await humanDelay(500, Day2000);
      }

      // Иногда переключаемся на поиск
      if (Math.random() < 0.05) {
        const results = await this.search(randomKeyword());
        // Просматриваем 2-3 результата
        for (const aweme of results.slice(0, 3)) {
          if (Date.now() >= endTime) break;
          if (!aweme?.aweme_id) continue;
          const watchTime = randInt(3000, 15000);
          await this.viewVideo(aweme, watchTime);
          if (Math.random() < 0.25) await this.likeVideo(aweme);
        }
      }

      // Небольшая пауза перед следующей пачкой
      await humanDelay(2000, 5000);
    }

    return videosWatched;
  }

  /**
   * Полный цикл прогрева.
   * days — сколько дней.
 — сколько минут в день.
   */
  async warmAccount(days = 3, minutesPerDay = 20) {
    console.log(`[warmer] Начинаю прогрев на ${days} дней по ${minutesPerDay} мин`);

    for (let day = 1; day <= days; day++) {
      console.log(`[warmer] День ${day}/${days}`);

      // Утренняя сессия
      try {
        console.log('[warmer] Утро — For You');
        await this.scrollSession(minutesPerDay * 30); // половина времени
      } catch (e) {
        console.error('[warmer] morning error:', e.message);
      }

      // Дневная пауза
      await humanDelay(3 * 60 * 60 * 1000, 5 * 60 * 60 * 1000);

      // Дневная сессия — поиск
      try {
        console.log('[warmer] День — поиск');
        const results = await this.search(randomKeyword());
        for (const aweme of results.slice(0, 10)) {
          if (!aweme?.aweme_id) continue;
          await this.viewVideo(aweme, randInt(3000, 15000));
          if (Math.random() < 0.25) await this.likeVideo(aweme);
          if (Math.random() < 0.02) await this.commentVideo(aweme);
          await humanDelay(1000, 3000);
        }
        await this.scrollSession(minutesPerDay * 20);
      } catch (e) {
        console.error('[warmer] midday error:', e.message);
      }

      // Вечерняя пауза
      await humanDelay(3 * 60 * 60 * 1000, 5 * 60 * 60 * 1000);

      // Вечерняя сессия
      try {
        console.log('[warmer] Вечер — For You');
        await this.scrollSession(minutesPerDay * 30);
      } catch (e) {
        console.error('[warmer] evening error:', e.message);
      }

      // Ночная пауза между днями
      if (day < days) {
        console.log('[warmer] Ночная пауза 8 часов');
        await humanDelay(7 * 60 * 60 * 1000, 9 * 60 * 60 * 1000);
      }
    }

    console.log('[warmer] Прогрев завершён:', JSON.stringify(this.stats));
    return this.stats;
  }
}

module.exports = { TikTokMobileWarmer, randomComment, randomKeyword };
