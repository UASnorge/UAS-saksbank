// Gjør kjente, vanskelig lesbare API-feil om til en klar norsk beskjed som sier
// hva som faktisk må gjøres. Brukes overalt der en feilmelding vises til
// redaksjonen (historikk, toast, assistentsvar) — rå JSON fra OpenAI sier
// ingenting om at det er kontoen som er tom, ikke saken som er feil.

function friendlyError(message) {
  var m = String(message || "");
  if (/insufficient_quota|credit_balance_exhausted|exceeded your current quota|no credits remaining/i.test(m)) {
    return "OpenAI-kontoen har ikke mer kreditt, så alle AI-funksjoner (manus, assistent, bildesøk, vurdering) står stille. " +
      "Fyll på kreditt på https://platform.openai.com/settings/organization/billing — saken er ikke feil, prøv igjen etterpå.";
  }
  if (/\(429\)|rate.?limit/i.test(m) && /OpenAI/i.test(m)) {
    return "OpenAI har midlertidig for mange forespørsler (grense nådd). Vent et minutt og prøv igjen.";
  }
  return m;
}

module.exports = { friendlyError };
