// ==UserScript==
// @name         HH: безопасные автоотклики из поиска
// @namespace    local.hh-auto-response
// @version      2.2.0
// @description  Последовательно отправляет отклики из текущей выдачи HH и возвращается из отдельных анкет с вопросами.
// @match        https://hh.ru/search/vacancy*
// @match        https://*.hh.ru/search/vacancy*
// @match        https://hh.ru/applicant/vacancy_response*
// @match        https://*.hh.ru/applicant/vacancy_response*
// @match        https://hh.kz/search/vacancy*
// @match        https://*.hh.kz/search/vacancy*
// @match        https://hh.kz/applicant/vacancy_response*
// @match        https://*.hh.kz/applicant/vacancy_response*
// @match        https://hh.uz/search/vacancy*
// @match        https://*.hh.uz/search/vacancy*
// @match        https://hh.uz/applicant/vacancy_response*
// @match        https://*.hh.uz/applicant/vacancy_response*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'hh-auto-response-v2';
  const SETTINGS_KEY = `${APP_ID}:settings`;
  const SESSION_KEY = `${APP_ID}:session`;
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const MAX_LOG_ENTRIES = 80;
  const LOCAL_TEST_MODE = location.hostname === '127.0.0.1'
    && location.pathname === '/search/vacancy-test';

  if (window.__hhAutoResponseV2Loaded) {
    console.info('[HH Auto] Скрипт уже запущен на этой странице.');
    return;
  }
  window.__hhAutoResponseV2Loaded = true;

  const DEFAULT_SETTINGS = Object.freeze({
    limit: 100,
    minDelaySeconds: 7,
    maxDelaySeconds: 12,
    coverLetter: '',
    skipComplexForms: true,
  });

  const SELECTORS = Object.freeze({
    card: '[data-qa="vacancy-serp__vacancy"]',
    title: '[data-qa="serp-item__title"]',
    response: '[data-qa="vacancy-serp__vacancy_response"]',
    nextPage: '[data-qa="pager-next"]',
    responseDialog: [
      '[data-qa="vacancy-response-popup"]',
      '[role="dialog"]',
    ].join(', '),
    coverLetter: '[data-qa="vacancy-response-popup-form-letter-input"]',
    submit: '[data-qa="vacancy-response-submit-popup"]',
    relocationConfirm: '[data-qa="relocation-warning-confirm"]',
  });

  let settings = loadJson(SETTINGS_KEY, DEFAULT_SETTINGS);
  let session = loadSession();
  let running = false;
  let navigationPending = false;
  let consecutiveErrors = 0;
  let ui = null;

  function loadJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value && typeof value === 'object' ? { ...fallback, ...value } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }

  function loadSession() {
    const fallback = {
      active: false,
      signature: '',
      startedAt: 0,
      updatedAt: 0,
      returnUrl: '',
      pendingVacancy: null,
      processedIds: [],
      stats: { attempted: 0, success: 0, skipped: 0, manual: 0, errors: 0, pages: 0 },
      logs: [],
    };
    return loadJson(SESSION_KEY, fallback);
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function saveSession() {
    session.updatedAt = Date.now();
    if (session.processedIds.length > 2000) {
      session.processedIds = session.processedIds.slice(-2000);
    }
    if (session.logs.length > MAX_LOG_ENTRIES) {
      session.logs = session.logs.slice(-MAX_LOG_ENTRIES);
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    renderStatus();
  }

  function searchSignature() {
    const url = new URL(location.href);
    ['page', 'search_session_id', 'hhtmFrom', 'hhtmFromLabel'].forEach((name) => {
      url.searchParams.delete(name);
    });
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  }

  function isSearchPage() {
    return location.pathname.startsWith('/search/vacancy');
  }

  function isStandaloneResponsePage() {
    return location.pathname.startsWith('/applicant/vacancy_response');
  }

  function validSearchUrl(value) {
    try {
      const url = new URL(value || '', location.href);
      return url.origin === location.origin && url.pathname.startsWith('/search/vacancy')
        ? url.toString()
        : '';
    } catch {
      return '';
    }
  }

  function normalizeSpace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function log(message, level = 'info') {
    const entry = {
      at: new Date().toLocaleTimeString('ru-RU'),
      level,
      message: normalizeSpace(message),
    };
    session.logs.push(entry);
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    console[method](`[HH Auto] ${entry.message}`);
    saveSession();
  }

  function currentPageNumber() {
    const value = Number(new URL(location.href).searchParams.get('page') || 0);
    return Number.isFinite(value) ? value + 1 : 1;
  }

  function findExactTextElement(root, pattern, selector = 'button, a, [role="button"]') {
    return [...root.querySelectorAll(selector)].find((element) => {
      return isVisible(element) && pattern.test(normalizeSpace(element.textContent));
    }) || null;
  }

  function extractVacancyId(card, responseButton) {
    const responseHref = responseButton?.getAttribute('href') || '';
    const responseMatch = responseHref.match(/[?&]vacancyId=(\d+)/i);
    if (responseMatch) return responseMatch[1];

    const titleHref = card.querySelector(SELECTORS.title)?.getAttribute('href') || '';
    const titleMatch = titleHref.match(/\/vacancy\/(\d+)/i);
    if (titleMatch) return titleMatch[1];

    const innerId = [...card.querySelectorAll('[id]')]
      .map((element) => element.id)
      .find((id) => /^\d{6,}$/.test(id));
    return innerId || null;
  }

  function vacancyTitle(card) {
    return normalizeSpace(card.querySelector(SELECTORS.title)?.textContent || 'Без названия');
  }

  function getCandidates() {
    return [...document.querySelectorAll(SELECTORS.card)].map((card) => {
      const button = card.querySelector(SELECTORS.response);
      if (!button || !isVisible(button)) return null;
      const id = extractVacancyId(card, button);
      if (!id) return null;
      return { card, button, id, title: vacancyTitle(card) };
    }).filter(Boolean);
  }

  function isSupportedResponseLink(button) {
    try {
      const url = new URL(button.href, location.href);
      const hhHost = /(^|\.)hh\.(ru|kz|uz)$/i.test(url.hostname);
      return hhHost && url.pathname.startsWith('/applicant/vacancy_response');
    } catch {
      return false;
    }
  }

  function looksLoggedOut() {
    const profileMarker = document.querySelector([
      '[data-qa="mainmenu_myResumes"]',
      '[data-qa="supernova-navi-item-responses"]',
      '[data-qa*="applicant-profile"]',
    ].join(', '));
    if (profileMarker) return false;
    return Boolean(findExactTextElement(document, /^Войти$/i));
  }

  function detectBlockingPage() {
    const title = normalizeSpace(document.title).toLowerCase();
    const body = normalizeSpace(document.body?.innerText).toLowerCase();
    if (/captcha|капч/.test(title) || /подтвердите,? что вы не робот|проверка безопасности/.test(body)) {
      return 'HeadHunter показал проверку/капчу';
    }
    if (/слишком много запросов|too many requests|ошибка 429/.test(body)) {
      return 'HeadHunter ограничил частоту запросов';
    }
    if (/^\/account\/(login|signup)/.test(location.pathname)) {
      return 'требуется вход в аккаунт';
    }
    return null;
  }

  function findResponseDialog() {
    return [...document.querySelectorAll(SELECTORS.responseDialog)].find((dialog) => {
      if (!isVisible(dialog)) return false;
      const text = normalizeSpace(dialog.textContent);
      return dialog.querySelector(`${SELECTORS.coverLetter}, ${SELECTORS.submit}, ${SELECTORS.relocationConfirm}`)
        || /отклик|резюме|сопроводительн/i.test(text);
    }) || null;
  }

  function cardShowsSuccess(id) {
    const cards = [...document.querySelectorAll(SELECTORS.card)];
    const card = cards.find((item) => {
      const titleHref = item.querySelector(SELECTORS.title)?.getAttribute('href') || '';
      const responseHref = item.querySelector(SELECTORS.response)?.getAttribute('href') || '';
      return titleHref.includes(`/vacancy/${id}`) || responseHref.includes(`vacancyId=${id}`);
    });
    return Boolean(card && /вы откликнулись|отклик отправлен|резюме доставлено/i.test(card.innerText));
  }

  function visibleSuccessNotice() {
    const candidates = document.querySelectorAll([
      '[role="status"]',
      '[role="alert"]',
      '[data-qa*="notification"]',
      '[data-qa*="response-success"]',
    ].join(', '));
    return [...candidates].some((element) => {
      return isVisible(element)
        && /отклик отправлен|вы откликнулись|резюме доставлено|отклик успешно отправлен/i.test(element.textContent || '');
    });
  }

  function dialogShowsSuccess(dialog = findResponseDialog()) {
    return Boolean(
      dialog
      && isVisible(dialog)
      && /отклик отправлен|вы откликнулись|резюме доставлено|отклик успешно отправлен/i.test(dialog.innerText),
    );
  }

  function setControlledValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function sleep(ms) {
    const deadline = Date.now() + ms;
    while (running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }

  async function waitFor(check, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (running && Date.now() < deadline) {
      const result = check();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function randomDelayMs() {
    const min = Math.max(1, settings.minDelaySeconds) * 1000;
    const max = Math.max(settings.minDelaySeconds, settings.maxDelaySeconds) * 1000;
    return Math.round(min + Math.random() * (max - min));
  }

  function dialogHasComplexQuestions(dialog) {
    const text = normalizeSpace(dialog.innerText);
    if (/ответьте на вопросы|вопросы работодателя|пройти тест|заполните анкету/i.test(text)) return true;

    const unknownFields = [...dialog.querySelectorAll('textarea, select, input')].filter((field) => {
      if (!isVisible(field) || field.matches(SELECTORS.coverLetter)) return false;
      if (field.matches('input[type="hidden"], input[type="submit"], input[type="button"]')) return false;
      if (field.matches('input[type="radio"][name*="resume" i]')) return false;
      return true;
    });
    return unknownFields.length > 0;
  }

  async function ensureCoverLetter(dialog) {
    let field = dialog.querySelector(SELECTORS.coverLetter);
    if (!settings.coverLetter.trim()) {
      const dialogText = normalizeSpace(dialog.innerText);
      const required = field && (
        field.required
        || field.getAttribute('aria-required') === 'true'
        || /сопроводительн[а-яё]*\s+письм[а-яё]*.{0,40}обязател|обязател[а-яё]*.{0,40}сопроводительн[а-яё]*\s+письм/i.test(dialogText)
      );
      return required
        ? { ok: false, reason: 'вакансия требует обязательное сопроводительное письмо' }
        : { ok: true };
    }

    if (!field) {
      const toggle = findExactTextElement(
        dialog,
        /^(добавить|написать).*сопроводительн(ое|ым).*письм/i,
      );
      if (toggle) {
        toggle.click();
        field = await waitFor(() => dialog.querySelector(SELECTORS.coverLetter), 4000);
      }
    }

    if (!field) {
      return { ok: false, reason: 'не найдено поле сопроводительного письма' };
    }

    setControlledValue(field, settings.coverLetter.trim());
    await sleep(500);
    return { ok: true };
  }

  function findSubmitButton(dialog) {
    const bySelector = dialog.querySelector(SELECTORS.submit);
    if (bySelector && isVisible(bySelector)) return bySelector;
    return findExactTextElement(dialog, /^(откликнуться|отправить|отправить отклик)$/i, 'button');
  }

  async function processDialog(dialog, vacancyId) {
    if (dialogHasComplexQuestions(dialog)) {
      return {
        type: 'manual',
        reason: 'обнаружены вопросы работодателя или неоднозначные поля',
      };
    }

    const letterResult = await ensureCoverLetter(dialog);
    if (!letterResult.ok) return { type: 'manual', reason: letterResult.reason };

    const submit = await waitFor(() => findSubmitButton(dialog), 4000);
    if (!submit) return { type: 'manual', reason: 'не найдена кнопка отправки в форме' };

    const enabledSubmit = await waitFor(() => !submit.disabled && submit.getAttribute('aria-disabled') !== 'true' && submit, 5000);
    if (!enabledSubmit) return { type: 'manual', reason: 'кнопка отправки осталась неактивной' };

    enabledSubmit.click();

    const outcome = await waitFor(() => {
      const blocker = detectBlockingPage();
      if (blocker) return { type: 'fatal', reason: blocker };
      if (cardShowsSuccess(vacancyId) || visibleSuccessNotice() || dialogShowsSuccess(dialog)) {
        return { type: 'success' };
      }

      const warning = document.querySelector(SELECTORS.relocationConfirm);
      if (warning && isVisible(warning)) return { type: 'relocation', button: warning };
      return null;
    }, 12000);

    if (outcome?.type === 'relocation') {
      outcome.button.click();
      return waitFor(() => {
        if (cardShowsSuccess(vacancyId) || visibleSuccessNotice() || dialogShowsSuccess()) {
          return { type: 'success' };
        }
        const blocker = detectBlockingPage();
        return blocker ? { type: 'fatal', reason: blocker } : null;
      }, 12000) || { type: 'error', reason: 'не удалось подтвердить отклик после предупреждения о переезде' };
    }

    return outcome || { type: 'error', reason: 'сайт не показал подтверждение отправки' };
  }

  async function closeFinishedDialog() {
    const dialog = findResponseDialog();
    if (!dialog) return true;

    const close = dialog.querySelector([
      '[data-qa*="close"]',
      'button[aria-label*="закр" i]',
    ].join(', ')) || findExactTextElement(dialog, /^(готово|закрыть|продолжить поиск)$/i, 'button');

    if (!close || !isVisible(close)) return false;
    close.click();
    return Boolean(await waitFor(() => !findResponseDialog() && true, 4000));
  }

  function findDialogCloseControl(dialog) {
    const selectors = [
      '[data-qa="vacancy-response-popup-close"]',
      '[data-qa="vacancy-response-popup-close-button"]',
      '[data-qa="bloko-modal-close"]',
      'button[data-qa*="modal-close"]',
      'button[data-qa*="popup-close"]',
      'button[aria-label*="закрыть" i]',
      'button[title*="закрыть" i]',
    ].join(', ');
    const bySelector = [...dialog.querySelectorAll(selectors)].find(isVisible);
    if (bySelector) return bySelector;
    return findExactTextElement(dialog, /^(отмена|закрыть|пропустить|не сейчас)$/i, 'button, a, [role="button"]');
  }

  async function dismissComplexDialog() {
    const dialog = findResponseDialog();
    if (!dialog) return true;

    const close = findDialogCloseControl(dialog);
    if (close) {
      close.click();
      if (await waitFor(() => !findResponseDialog() && true, 4000)) return true;
    }

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(escapeEvent);
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }));
    return Boolean(await waitFor(() => !findResponseDialog() && true, 2000));
  }

  async function reloadAndResume(reason) {
    log(`${reason}; перезагружаю выдачу и продолжаю`, 'warn');
    navigationPending = true;
    session.active = true;
    saveSession();
    location.reload();
    await new Promise(() => {});
  }

  async function returnToSearchAndResume(reason) {
    const target = validSearchUrl(session.returnUrl) || validSearchUrl(document.referrer);
    if (!target) {
      await stop(`${reason}; не удалось определить адрес поисковой выдачи`, 'error');
      return;
    }

    log(`${reason}; возвращаюсь к выдаче и продолжаю`, 'warn');
    navigationPending = true;
    session.active = true;
    session.pendingVacancy = null;
    saveSession();
    location.replace(target);
    await new Promise(() => {});
  }

  async function applyToVacancy(candidate) {
    if (!document.contains(candidate.button)) {
      return { type: 'skip', reason: 'карточка обновилась до нажатия' };
    }

    if (!isSupportedResponseLink(candidate.button)) {
      return { type: 'skip', reason: 'внешняя анкета или нестандартный сценарий' };
    }

    const existingDialog = findResponseDialog();
    if (existingDialog) {
      return { type: 'manual', reason: 'на странице уже открыта форма отклика' };
    }

    session.stats.attempted += 1;
    session.returnUrl = location.href;
    session.pendingVacancy = { id: candidate.id, title: candidate.title };
    navigationPending = true;
    saveSession();
    candidate.button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(350);
    candidate.button.click();

    const initial = await waitFor(() => {
      const blocker = detectBlockingPage();
      if (blocker) return { kind: 'fatal', reason: blocker };
      if (isStandaloneResponsePage()) {
        return { kind: 'separate' };
      }
      if (!isSearchPage()) {
        return { kind: 'fatal', reason: 'сайт перешёл на неожиданную страницу' };
      }
      if (cardShowsSuccess(candidate.id) || visibleSuccessNotice() || dialogShowsSuccess()) {
        return { kind: 'success' };
      }

      const relocation = document.querySelector(SELECTORS.relocationConfirm);
      if (relocation && isVisible(relocation)) return { kind: 'relocation', button: relocation };

      const dialog = findResponseDialog();
      return dialog ? { kind: 'dialog', dialog } : null;
    }, 10000);

    if (isSearchPage()) navigationPending = false;

    if (!initial) return { type: 'error', reason: 'форма отклика не появилась' };
    if (initial.kind === 'fatal') return { type: 'fatal', reason: initial.reason };
    if (initial.kind === 'separate') {
      return { type: 'separate', reason: 'открылась отдельная анкета с вопросами' };
    }
    if (initial.kind === 'success') return { type: 'success' };

    if (initial.kind === 'relocation') {
      initial.button.click();
      const next = await waitFor(() => {
        if (cardShowsSuccess(candidate.id) || visibleSuccessNotice() || dialogShowsSuccess()) {
          return { kind: 'success' };
        }
        const dialog = findResponseDialog();
        return dialog ? { kind: 'dialog', dialog } : null;
      }, 8000);
      if (!next) return { type: 'error', reason: 'после подтверждения переезда форма не появилась' };
      if (next.kind === 'success') return { type: 'success' };
      initial.dialog = next.dialog;
    }

    return processDialog(initial.dialog, candidate.id);
  }

  function markProcessed(id) {
    if (!session.processedIds.includes(id)) session.processedIds.push(id);
  }

  function clearPendingVacancy(id) {
    if (!id || session.pendingVacancy?.id === id) session.pendingVacancy = null;
  }

  async function handleResult(candidate, result) {
    if (result.type !== 'manual' && result.type !== 'separate') markProcessed(candidate.id);

    if (result.type === 'success') {
      clearPendingVacancy(candidate.id);
      session.stats.success += 1;
      consecutiveErrors = 0;
      log(`Готово: ${candidate.title} (${session.stats.success}/${settings.limit})`);
      const closed = await closeFinishedDialog();
      if (!closed) {
        await reloadAndResume('Окно успешного отклика не закрылось обычной кнопкой');
      }
      return;
    }

    if (result.type === 'skip') {
      clearPendingVacancy(candidate.id);
      session.stats.skipped += 1;
      consecutiveErrors = 0;
      log(`Пропуск: ${candidate.title} — ${result.reason}`, 'warn');
      return;
    }

    if (result.type === 'manual') {
      session.stats.manual += 1;
      if (!settings.skipComplexForms) {
        clearPendingVacancy(candidate.id);
        log(`Нужно вручную: ${candidate.title} — ${result.reason}`, 'warn');
        await stop(`Остановлено на вакансии «${candidate.title}»: ${result.reason}`, 'warn');
        return;
      }

      markProcessed(candidate.id);
      clearPendingVacancy(candidate.id);
      consecutiveErrors = 0;
      log(`Пропуск сложной формы: ${candidate.title} — ${result.reason}`, 'warn');
      const dismissed = await dismissComplexDialog();
      if (!dismissed) {
        await reloadAndResume('Сложная форма не закрылась обычной кнопкой');
      }
      return;
    }

    if (result.type === 'separate') {
      session.stats.manual += 1;
      if (!settings.skipComplexForms) {
        clearPendingVacancy(candidate.id);
        log(`Нужно вручную: ${candidate.title} — ${result.reason}`, 'warn');
        await stop(`остановлено на анке вакансии «${candidate.title}»`, 'warn');
        return;
      }

      markProcessed(candidate.id);
      log(`Пропуск сложной формы: ${candidate.title} — ${result.reason}`, 'warn');
      await returnToSearchAndResume('Анкета с вопросами пропущена');
      return;
    }

    clearPendingVacancy(candidate.id);
    session.stats.errors += 1;
    consecutiveErrors += 1;
    log(`Ошибка: ${candidate.title} — ${result.reason}`, 'error');

    if (result.type === 'fatal' || consecutiveErrors >= 3) {
      const reason = result.type === 'fatal'
        ? result.reason
        : 'три ошибки подряд — вероятно, HeadHunter изменил интерфейс или ограничил запросы';
      await stop(reason, 'error');
    }
  }

  async function goToNextPage() {
    const next = document.querySelector(SELECTORS.nextPage);
    if (!next || !isVisible(next)) return false;

    const oldUrl = location.href;
    const oldFirstId = getCandidates()[0]?.id || '';
    session.stats.pages = Math.max(session.stats.pages, currentPageNumber());
    navigationPending = true;
    saveSession();
    next.click();

    const changed = await waitFor(() => {
      const firstId = getCandidates()[0]?.id || '';
      return location.href !== oldUrl && firstId && firstId !== oldFirstId;
    }, 25000);

    navigationPending = false;
    if (!changed) {
      await stop('следующая страница не загрузилась за 25 секунд', 'error');
      return false;
    }

    session.signature = searchSignature();
    session.stats.pages = Math.max(session.stats.pages, currentPageNumber());
    log(`Открыта страница ${currentPageNumber()}`);
    return true;
  }

  async function run() {
    if (running) return;
    running = true;
    session.active = true;
    session.signature = searchSignature();
    saveSession();
    renderStatus();

    try {
      while (running && session.stats.success < settings.limit) {
        const blocker = detectBlockingPage();
        if (blocker) {
          await stop(blocker, 'error');
          break;
        }

        const maxAttempts = Math.max(settings.limit * 3, settings.limit + 20);
        if (session.stats.attempted >= maxAttempts) {
          await stop(`достигнут защитный предел ${maxAttempts} попыток`, 'warn');
          break;
        }

        const processed = new Set(session.processedIds);
        const candidates = getCandidates().filter(({ id }) => !processed.has(id));

        for (const candidate of candidates) {
          if (!running || session.stats.success >= settings.limit) break;
          log(`Обработка: ${candidate.title}`);
          const result = await applyToVacancy(candidate);
          await handleResult(candidate, result);
          if (!running || session.stats.success >= settings.limit) break;

          const delayMs = randomDelayMs();
          setUiMessage(`Пауза ${Math.ceil(delayMs / 1000)} сек.`);
          await sleep(delayMs);
        }

        if (!running || session.stats.success >= settings.limit) break;
        const moved = await goToNextPage();
        if (!moved) {
          if (running) await stop('в выдаче больше нет страниц', 'info');
          break;
        }
      }

      if (running && session.stats.success >= settings.limit) {
        await stop(`лимит ${settings.limit} успешных откликов достигнут`, 'info');
      }
    } catch (error) {
      console.error('[HH Auto] Необработанная ошибка:', error);
      await stop(`необработанная ошибка: ${error?.message || error}`, 'error');
    }
  }

  async function stop(reason, level = 'info') {
    const wasActive = running || session.active;
    running = false;
    session.active = false;
    if (wasActive && reason) log(`Стоп: ${reason}`, level);
    else saveSession();
    setUiMessage(reason || 'Остановлено');
    renderStatus();
  }

  function readSettingsFromUi() {
    const limit = Number(ui.limit.value);
    const minDelay = Number(ui.minDelay.value);
    const maxDelay = Number(ui.maxDelay.value);

    settings = {
      limit: Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 100)),
      minDelaySeconds: Math.min(120, Math.max(3, Number.isFinite(minDelay) ? minDelay : 7)),
      maxDelaySeconds: Math.min(180, Math.max(3, Number.isFinite(maxDelay) ? maxDelay : 12)),
      coverLetter: ui.coverLetter.value.slice(0, 10000),
      skipComplexForms: ui.skipComplex.checked,
    };
    if (settings.maxDelaySeconds < settings.minDelaySeconds) {
      settings.maxDelaySeconds = settings.minDelaySeconds;
    }
    saveSettings();
  }

  async function startFromUi() {
    if (running) {
      await stop('остановлено пользователем', 'warn');
      return;
    }

    if (!isSearchPage()) {
      setUiMessage('Откройте страницу поиска вакансий');
      return;
    }
    if (looksLoggedOut()) {
      setUiMessage('Сначала войдите в аккаунт HH');
      alert('Сначала войдите в аккаунт HeadHunter, затем вернитесь в выдачу вакансий.');
      return;
    }

    readSettingsFromUi();
    const signature = searchSignature();
    const continueOld = session.signature === signature && session.processedIds.length > 0;
    const confirmationText = [
      `Скрипт будет отправлять отклики работодателям от вашего имени.`,
      `Лимит: ${settings.limit}; пауза: ${settings.minDelaySeconds}–${settings.maxDelaySeconds} сек.`,
      settings.coverLetter.trim() ? 'Сопроводительное письмо включено.' : 'Без сопроводительного письма.',
      continueOld ? 'Будет продолжена текущая сессия.' : 'Будет создана новая сессия.',
      '',
      'Продолжить?',
    ].join('\n');
    const confirmed = LOCAL_TEST_MODE || confirm(confirmationText);
    if (!confirmed) return;

    if (!continueOld || session.stats.success >= settings.limit) {
      session = {
        active: false,
        signature,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        returnUrl: location.href,
        pendingVacancy: null,
        processedIds: [],
        stats: { attempted: 0, success: 0, skipped: 0, manual: 0, errors: 0, pages: 0 },
        logs: [],
      };
    }
    log('Запуск подтверждён пользователем');
    await run();
  }

  function resetSession() {
    if (running) {
      setUiMessage('Сначала остановите выполнение');
      return;
    }
    session = {
      active: false,
      signature: searchSignature(),
      startedAt: 0,
      updatedAt: Date.now(),
      returnUrl: isSearchPage() ? location.href : '',
      pendingVacancy: null,
      processedIds: [],
      stats: { attempted: 0, success: 0, skipped: 0, manual: 0, errors: 0, pages: 0 },
      logs: [],
    };
    saveSession();
    setUiMessage('Сессия сброшена');
  }

  function setUiMessage(message) {
    if (ui?.message) ui.message.textContent = normalizeSpace(message);
  }

  function renderStatus() {
    if (!ui) return;
    const stats = session.stats;
    ui.start.textContent = running ? 'Остановить' : 'Запустить';
    ui.start.dataset.running = String(running);
    ui.status.textContent = running ? 'Работает' : 'Остановлен';
    ui.counts.textContent = `Успешно ${stats.success} · попыток ${stats.attempted} · пропусков ${stats.skipped} · вручную ${stats.manual} · ошибок ${stats.errors}`;
    const latest = session.logs.at(-1);
    if (latest) ui.message.textContent = latest.message;
  }

  function mountUi() {
    const host = document.createElement('div');
    host.id = APP_ID;
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { width: 320px; padding: 14px; border: 1px solid #d7d7d7; border-radius: 16px; background: #fff; color: #111; box-shadow: 0 12px 36px rgba(0,0,0,.22); font: 13px/1.35 Arial, sans-serif; }
        .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
        .title { font-weight:700; font-size:15px; }
        .status { color:#666; font-size:12px; }
        .row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:7px; margin:8px 0; }
        label { display:block; color:#555; font-size:11px; }
        input[type="number"], textarea { box-sizing:border-box; width:100%; margin-top:3px; border:1px solid #bbb; border-radius:8px; padding:7px; color:#111; background:#fff; font:12px Arial,sans-serif; }
        textarea { min-height:62px; resize:vertical; }
        .check { display:flex; gap:7px; align-items:flex-start; margin:8px 0; color:#333; font-size:12px; }
        .actions { display:flex; gap:8px; margin-top:10px; }
        button { border:0; border-radius:9px; padding:9px 12px; cursor:pointer; font-weight:700; }
        #start { flex:1; background:#1785e5; color:#fff; }
        #start[data-running="true"] { background:#d74242; }
        #reset { background:#eee; color:#333; }
        .counts { margin-top:9px; color:#333; font-size:11px; }
        .message { max-height:42px; overflow:hidden; margin-top:5px; color:#666; font-size:11px; }
      </style>
      <section class="panel" aria-label="Автоотклики HH">
        <div class="head"><span class="title">HH автоотклики</span><span id="status" class="status"></span></div>
        <div class="row">
          <label>Лимит<input id="limit" type="number" min="1" max="100"></label>
          <label>Пауза от, с<input id="minDelay" type="number" min="3" max="120"></label>
          <label>до, с<input id="maxDelay" type="number" min="3" max="180"></label>
        </div>
        <label>Сопроводительное письмо<textarea id="coverLetter" placeholder="Можно оставить пустым"></textarea></label>
        <label class="check"><input id="skipComplex" type="checkbox">Пропускать обязательные письма, вопросы и сложные формы</label>
        <div class="actions"><button id="start" type="button"></button><button id="reset" type="button">Сброс</button></div>
        <div id="counts" class="counts"></div>
        <div id="message" class="message" aria-live="polite">Готов к запуску</div>
      </section>`;

    document.body.append(host);
    ui = {
      host,
      start: shadow.querySelector('#start'),
      reset: shadow.querySelector('#reset'),
      status: shadow.querySelector('#status'),
      counts: shadow.querySelector('#counts'),
      message: shadow.querySelector('#message'),
      limit: shadow.querySelector('#limit'),
      minDelay: shadow.querySelector('#minDelay'),
      maxDelay: shadow.querySelector('#maxDelay'),
      coverLetter: shadow.querySelector('#coverLetter'),
      skipComplex: shadow.querySelector('#skipComplex'),
    };

    ui.limit.value = settings.limit;
    ui.minDelay.value = settings.minDelaySeconds;
    ui.maxDelay.value = settings.maxDelaySeconds;
    ui.coverLetter.value = settings.coverLetter;
    ui.skipComplex.checked = settings.skipComplexForms;
    ui.start.addEventListener('click', startFromUi);
    ui.reset.addEventListener('click', resetSession);
    renderStatus();
  }

  window.addEventListener('pagehide', () => {
    if (running && !navigationPending) {
      session.active = false;
      session.updatedAt = Date.now();
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
  });

  function maybeResumeAfterPageNavigation() {
    const fresh = Date.now() - session.updatedAt < SESSION_TTL_MS;
    const sameSearch = session.signature === searchSignature();
    if (!session.active || !fresh || !sameSearch) {
      if (session.active) {
        session.active = false;
        saveSession();
      }
      return;
    }

    setUiMessage('Продолжаю сессию после перехода…');
    setTimeout(() => run(), 1200);
  }

  async function maybeReturnFromStandaloneResponsePage() {
    if (!isStandaloneResponsePage()) return false;

    const fresh = Date.now() - session.updatedAt < SESSION_TTL_MS;
    if (!session.active || !fresh) {
      setUiMessage('Откройте выдачу вакансий и запустите скрипт там');
      return true;
    }

    const pending = session.pendingVacancy;
    if (!settings.skipComplexForms) {
      clearPendingVacancy(pending?.id);
      await stop('открылась отдельная анкета с вопросами', 'warn');
      return true;
    }

    if (pending?.id) {
      markProcessed(pending.id);
      session.stats.manual += 1;
      log(`Пропуск сложной формы: ${pending.title || pending.id} — отдельная анкета с вопросами`, 'warn');
    }
    await returnToSearchAndResume('Анкета с вопросами пропущена');
    return true;
  }

  async function initialize() {
    mountUi();
    if (await maybeReturnFromStandaloneResponsePage()) return;
    maybeResumeAfterPageNavigation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
