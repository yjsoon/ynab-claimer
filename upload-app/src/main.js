import { initTheme, initAuthUi, checkAuth, hidePasswordPrompt } from './lib/core.js';
import { initPreview } from './lib/preview.js';
import {
  initClaims,
  loadReceipts,
  loadYnabTodos,
  setOnClaimsLoadError,
} from './claims.js';
import {
  initInvoices,
  showInvoicesView,
  isInvoicesPath,
  navigateToMode,
  renderInvoiceClaimLoadError,
} from './invoices.js';

initTheme();
initPreview();
initAuthUi();
initClaims();
initInvoices();
setOnClaimsLoadError(renderInvoiceClaimLoadError);

showInvoicesView(isInvoicesPath(), { refresh: false });

async function init() {
  if (await checkAuth()) {
    hidePasswordPrompt();
    await loadReceipts();
    await loadYnabTodos();
    const xeroJustConnected = new URLSearchParams(location.search).get('xero') === 'connected';
    if (xeroJustConnected) {
      navigateToMode(true, { replace: true });
    } else if (isInvoicesPath()) {
      showInvoicesView(true);
    }
  }
}

init();
