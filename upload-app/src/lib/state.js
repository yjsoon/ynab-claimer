export let receiptsData = [];
export let claimsData = [];
export let claimsLoadErrorMessage = '';

export function setReceiptsData(data) {
  receiptsData = data;
}

export function setClaimsData(data) {
  claimsData = data;
}

export function setClaimsLoadErrorMessage(message) {
  claimsLoadErrorMessage = message;
}
