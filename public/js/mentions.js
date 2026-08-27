/**
 * Adresse de la déléguée à la protection des données, dans les mentions légales.
 *
 * Elle vient de la configuration : un changement de personne se règle dans
 * l'administration, sans toucher à cette page.
 *
 * Ce code vivait dans un <script> en ligne, où la politique de sécurité de
 * contenu — « script-src 'self' » — l'empêchait de s'exécuter : la page
 * affichait donc les points de suspension du gabarit, et l'adresse enregistrée
 * n'apparaissait jamais. Un fichier servi par le site passe, une balise en
 * ligne non ; c'est tout l'objet de cette règle.
 */

const lien = document.getElementById('contact-dpo');
if (lien) {
  const repli = () => lien.replaceWith(
    document.createTextNode('adresse disponible auprès de la DSI')
  );

  try {
    const reponse = await fetch('/api/public/contacts');
    const { dpo } = await reponse.json();
    if (dpo) {
      lien.href = `mailto:${dpo}`;
      lien.textContent = dpo;
    } else repli();
  } catch {
    repli();
  }
}
