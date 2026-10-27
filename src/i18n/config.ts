import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import viTranslation from '../locales/vi/translation.json';
import enTranslation from '../locales/en/translation.json';

// Get saved language from localStorage, default to 'vi'
const getSavedLanguage = (): string => {
  if (typeof window === 'undefined') return 'vi';
  const saved = localStorage.getItem('app-language');
  return saved || 'vi';
};

i18next
  .use(initReactI18next)
  .init({
    resources: {
      vi: { translation: viTranslation },
      en: { translation: enTranslation },
    },
    lng: getSavedLanguage(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // React already handles XSS
    },
    ns: ['translation'],
    defaultNS: 'translation',
  });

// Đồng bộ ngôn ngữ giữa các cửa sổ — mỗi window Tauri có JS heap riêng, chỉ
// Settings gọi changeLanguage nên các window khác phải tự nghe để đổi theo.
const applyLanguage = (lang: unknown) => {
  if ((lang === 'vi' || lang === 'en') && lang !== i18next.language) {
    i18next.changeLanguage(lang);
  }
};

if (typeof window !== 'undefined') {
  // Window cùng origin ghi localStorage → các window khác nhận 'storage'.
  window.addEventListener('storage', (e) => {
    if (e.key === 'app-language') applyLanguage(e.newValue);
  });
  // Rust broadcast "settings-changed" kèm toàn bộ settings (xem
  // `commands::set_settings`) — đọc field "language".
  if ('__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<Record<string, unknown>>('settings-changed', (e) => {
          applyLanguage(e.payload?.language);
        }),
      )
      .catch(() => {});
  }
}

export default i18next;
