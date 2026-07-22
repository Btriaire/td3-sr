# TD-3-SR — Web Edition

Émulation Web Audio du **Behringer TD-3-SR** (clone TB-303, façade argentée) :
synthé bass line analogique avec séquenceur 16 pas, jouable dans le navigateur
— y compris sur iPhone.

## Fonctionnalités

- **VCO** : dent de scie / carré (switch WAVEFORM)
- **VCF** : passe-bas résonant ~24 dB/oct (2 biquads en cascade), auto-oscillation à résonance max
- **Enveloppe de filtre** : ENV MOD + DECAY (30 ms → 2 s), déclenchée à chaque note
- **ACCENT** : boost d'enveloppe + volume, decay raccourci (le « wow » du 303)
- **SLIDE** : portamento exponentiel entre pas liés, gate maintenu
- **DISTORTION** : waveshaper tanh sur-échantillonné 4×, on/off
- **Séquenceur 16 pas** : timing sans jitter (lookahead Web Audio), 8 patterns,
  modes PATTERN PLAY / PATTERN WRITE / TRACK PLAY / TRACK WRITE (chaînage de patterns)
- **Clavier 1 octave** + transpose DOWN/UP, TAP tempo (40–300 BPM)
- Patterns et réglages persistés en localStorage

## Utilisation

- **RUN** lance le séquenceur (pattern démo en Cm sur le pattern 1)
- Clic sur un **pas** = gate on/off
- **PITCH MODE** (= PATTERN WRITE) : le clavier écrit la note du pas sélectionné
  puis avance ; ACCENT / SLIDE marquent le pas ; BACK / WRITE-NEXT naviguent
- **TRACK WRITE** : taper les numéros de pattern construit la chaîne, jouée en TRACK PLAY
- Knobs : glisser verticalement (Shift = fin), molette, double-clic = reset

## Dev

```bash
npm install
npm run dev
```

## Déploiement

- **Vercel** : app Next.js standard, zéro config
- **VPS** : `docker compose up -d --build` (port 3200) + `deploy/nginx.conf` + certbot
