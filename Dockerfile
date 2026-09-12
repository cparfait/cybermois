# Version mineure epinglee : une reconstruction six mois plus tard doit produire
# la meme image. La balise node:24-alpine suit la branche 24 et peut basculer de
# version mineure sans prevenir, ce qui change le moteur SQLite embarque.
# Verifiee sur Docker Hub (library/node) au moment de la redaction.
FROM node:24.21-alpine

RUN apk add --no-cache tzdata && \
    ln -snf /usr/share/zoneinfo/Europe/Paris /etc/localtime && \
    echo "Europe/Paris" > /etc/timezone

WORKDIR /app

# Installation des dependances en couche separee pour profiter du cache Docker.
# npm ci et non npm install : le package-lock.json est suivi par git, c'est lui
# qui fait foi. npm install accepterait de le reecrire et l'image ne
# correspondrait plus a ce qui a ete teste.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY content ./content
# Le parametrage de classement voyage avec l'image : sans lui, l'import en
# production n'aurait aucun fichier a lire.
COPY parametrage ./parametrage

# La base SQLite et le certificat de l'AC sont montes depuis l'hote.
# UID fixe : le conteneur tourne en utilisateur non privilegie. Sans identifiant
# connu d'avance, le dossier monte appartiendrait a root et l'ecriture echouerait
# au premier defi joue. Cote hote : chown -R 10001:10001 <dossier monte>
RUN mkdir -p /app/data /app/certs && \
    addgroup -S -g 10001 cyber && adduser -S -u 10001 -G cyber cyber && \
    chown -R cyber:cyber /app
USER cyber

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

# GET /sante ne renvoie plus que { ok, version } : aucun effectif, rien de
# nominatif. Le healthcheck ne lit de toute facon que le code HTTP, il reste
# donc valable tel quel.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
