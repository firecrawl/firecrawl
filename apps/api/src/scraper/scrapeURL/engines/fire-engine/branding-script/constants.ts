export const CONSTANTS = {
  BUTTON_MIN_WIDTH: 50,
  BUTTON_MIN_HEIGHT: 25,
  BUTTON_MIN_PADDING_VERTICAL: 3,
  BUTTON_MIN_PADDING_HORIZONTAL: 6,
  MAX_PARENT_TRAVERSAL: 5,
  MAX_BACKGROUND_SAMPLES: 100,
  MIN_SIGNIFICANT_AREA: 1000,
  MIN_LARGE_CONTAINER_AREA: 10000,
  DUPLICATE_POSITION_THRESHOLD: 1,
  MIN_LOGO_SIZE: 25,
  MIN_ALPHA_THRESHOLD: 0.1,
  MAX_TRANSPARENT_ALPHA: 0.01,
  BUTTON_SELECTOR:
    'button,input[type="submit"],input[type="button"],[role=button],[data-primary-button],[data-secondary-button],[data-cta],a.button,a.btn,[class*="btn"],[class*="button"],a[class*="bg-brand"],a[class*="bg-primary"],a[class*="bg-accent"]',
  // Logo detection thresholds
  TASKBAR_TOP_THRESHOLD: 80,
  CONTAINER_TOP_THRESHOLD: 50,
  TASKBAR_LOGO_MAX_TOP: 120,
  TASKBAR_LOGO_MAX_LEFT: 450,
  TASKBAR_LOGO_MIN_WIDTH: 24,
  TASKBAR_LOGO_MIN_HEIGHT: 12,
  TOP_PAGE_THRESHOLD_PX: 500,
  // Button-like element class pattern
  BUTTON_CLASS_PATTERN:
    /rounded(-md|-lg|-xl|-full)?|p[xy]?-\d+|border.*rounded|inline-flex.*items-center.*justify-center/,
};
