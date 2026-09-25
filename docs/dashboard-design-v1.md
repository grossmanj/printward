# Printward – Design v1 (låst mock)

Status: Godkänd som visuell grund innan implementation.

## Huvudlayout

- Printward är startsidan.
- Flikar: Printward, Alla order, Pågående plock, Uppdaterade och Saknade.
- Uppdaterade visas endast i fliken `Uppdaterade` med en röd räknare.
- Knappen `Uppdatera` ligger centrerad i flikraden, ovanför Följesedlar och
  Fraktsedlar, med samma höjd som flikarna.

## Paneler

1. Följesedlar: Tidig, Förmiddag och Eftermiddag.
2. Fraktsedlar: Kyl & Frys, DSV Finland, Best Transport, Eriksson och
   Övriga Åkerier.
3. Följesedlar med krav på utskrift: Sushi Yama, ChopChop och Övriga kunder.
4. Returer: mellan följesedelspanelen och Hämtningar, bud & taxi.
5. Hämtningar, bud & taxi: Kundhämtning (grön), Swish betalning (gul) och
   Budbil / Taxi (lila).

## Gemensamt

- Mörkblå åtgärdsknappar har en gemensam höjd.
- `Visa order` i radlistor är alltid högerlinjerad.
- Designen är en lokal klickbar prototyp på
  `http://127.0.0.1:3100/printward-dashboard.html`.
- Ingen produktionsdata, utskrift eller extern publicering ingår i denna mock.
