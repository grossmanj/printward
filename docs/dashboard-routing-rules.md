# Printward – kända transportregler

Detta är bekräftade regler för dashboardens gruppering. Reglerna ska
verifieras mot verkliga Visma-data innan riktig utskrift aktiveras.

## Fraktsedlar

| Grupp | Identifiering | Status |
| --- | --- | --- |
| Kyl & Frys | Leverantörsnummer `7331697`, utom Eriksson | Fraktsedel |
| Eriksson | **Orderns** `DelMt=25` eller `49` (`K&F Danmark 13:00`) och leverantörsnummer `7331697` | Egen fraktsedelsgrupp, samma dokumentflöde som Kyl & Frys |
| DSV Finland | Leverantörsnummer `50063993`; orderns `DelMt=47` eller `48` | Fraktsedel |
| Best Transport | Leverantörsnummer `55058127` | Visa avgångar, ingen utskrift ännu |
| Jansen Logistic, Tyskland | Orderns `DelMt=52`; hämtar måndag och torsdag | Oklart dokumentbehov – visa först, ingen utskrift ännu |

## Prioritet för gruppering

Eriksson måste kontrolleras före den generella Kyl & Frys-regeln. Annars
skulle `DelMt=25` och `49` hamna fel eftersom de använder samma leverantörsnummer.
`Ord.Gr2` är inte körsättet och får inte användas för den här uppdelningen.
Fraktlistorna sorteras efter orderns `DelPri`, sedan `DelMt`, sedan ordernummer.

Att få **Eriksson** tryckt på nShifts fraktsedel och etikett är en separat,
ännu ej genomförd ändring. Ändra inte den gemensamma Kyl & Frys-mallen globalt:
det skulle även märka vanliga Kyl & Frys-sändningar. Kontrollera först ett
verkligt Eriksson-dokument och om Visma–nShift-integrationen kan skicka en
villkorad text för `DelMt=25/49` till en anpassad dokument-/etikettlayout.
Ägaren undersöker hos nShift om en separat mall kan skapas och väljas enbart
för Eriksson. Frågor att bekräfta: samma leverantörsnummer, val av mall från
integrationen, märkning på **både fraktsedel och etikett**, och att vanliga
Kyl & Frys-sändningar inte påverkas.
Det är ännu inte bekräftat om Eriksson har en eller flera avgångar. Behåll
`DelPri`-sorteringen per order och ändra inte avgångsgrupperingen förrän detta
är kontrollerat mot Visma.

## Följesedlar med krav på utskrift (att verifiera)

`Actor.DOCSMt` är den mest lovande källan för att avgöra om en kund ska ha
fysisk följesedel. I Visma-dialogen ska specifikt alternativet **Följesedlar
→ Skrivare** läsas; övriga dokumentrader och leveranssätt ska inte påverka
regeln.

Före implementation behövs provvärden för Sushi Yama, ChopChop, minst en
vanlig kund utan fysisk följesedel och en eventuell annan kund med kravet.
Målet är att förstå om `DOCSMt` är ett bitfält eller kräver en uppslagstabell.
Ändra inte kundernas Visma-inställningar innan den nuvarande fördelningen har
granskats och godkänts.

## Returer (att verifiera)

- `Ord.Gr3 = 30` betyder **Retur hämtas** och är nu huvudregeln i
  Returer-rutan, oberoende av orderns `DelMt`. `DelMt=151` kan fortfarande
  förekomma men krävs inte för att hitta returen.
- `Ord.Gr3 = 31` betyder **Retur finns i huset** och ska inte hamna i
  chaufförens hämtningslista.
- `Ord.Gr3 = 32` betyder **Kredit** och ska exkluderas.

Returer läses separat för valt leveransdatum (`TrTp=1`, ej makulerade).
Den vanliga order- och hämtningsvyn utesluter `Gr3=30` så att en retur som
fått ett vanligt körsätt inte dubbelräknas. Normalordrarnas krav på
processstatus används inte för returlistan. Kontrollera detta mot verkliga
Visma-returer innan utskrift aktiveras; returutskrift är fortfarande spärrad.

## Hämtningar, bud och taxi (lokal läsvy)

- `Ord.DelMt = 6`: kundhämtning (grön märkning).
- `Ord.DelMt = 16`: budbil (lila märkning).
- `Ord.DelMt = 42–46`: taxi (lila märkning).
- Kundhämtning med `Actor.CPmtTrm = 1` får dessutom gul märkning för
  Swish-betalning. Ingen Swish-slutsats görs för bud/taxi.
- Personalorder är en särskild grupp inom kundhämtning: `Actor.R12 = 60`
  och `Ord.DelMt = 6`. Rutan visar en egen fjärde rad och räknar dessa separat
  från övriga kundhämtningar utan att dubbelräkna totalen.
- Den vanliga orderfrågan utesluter leveranssätt 6. Rutan har därför en egen,
  read-only SQL-fråga. Verifiera kundfältet och exempelorder mot Visma innan
  utskrift kopplas in.

### Tillkommande krav inför utskrift

- När Swish-utskrift byggs ska den använda **fakturamall**, inte plocksedel.
  Dagens läsvy markerar bara betalningsvillkor och startar ingen utskrift.
- Kontrollera `Actor.R12` och minst en faktisk personalorder mot Visma innan
  personalgruppens data används i drift.

## Kedjornas status (lokal läsvy)

- `Actor.R12 = 41` är Sushi Yama; `Actor.R12 = 100` är ChopChop.
- Kortens `utskrivna / totalt` räknar en order som utskriven först när både
  följesedel och partibilaga har dokumentstatus `printed`. Saknade, ändrade
  och ännu ej utskrivna dokument räknas som kvar. Siffran är inte samma sak
  som att dokumenten finns tillgängliga för utskrift.
- Egna bilar identifieras med samma preliminära regel som Tidig/FM/EM.
  Extern leverantör blir fjärrgods; okänt körsätt markeras separat i stället
  för att antas vara fjärrgods.
- Övriga kunder får tills vidare ingen kvot. Där krävs en verifierad tolkning
  av `Actor.DocSmt`, så att endast kunder med krav på fysisk följesedel tas med.
- Ingen utskrift är kopplad till kedjekorten ännu. Kontrollera verkliga
  kedjeorder och hur utskrift från en egen bil syns i dokumentstatusen innan
  denna läsvy används operativt.

## Egna bilar – Tidig, FM, EM (preliminär läsvy)

- **Orderns** `Ord.DelPri`, inte kundkortets, avgör tid: före 07 = Tidig,
  07–11 = FM och 12–16 = EM. Saknad/annan tid hamnar inte i en snabbgrupp.
- Bekräftade egna bilars `Ord.DelMt`: `1–5`, `7–15`, `27` och `41`.
- När Pindeliver ersätter `DelMt` med ett regnummer matchas tills vidare en
  regnummerform i leveranssättets text, till exempel `UDG 62J` eller
  `302. RJA 13M`. Detta är en **preliminär läsregel**, inte en verifierad
  utskriftsregel. Externa leverantörsorder utesluts först.
- Klar betyder att både följesedel och partibilaga finns och att inget plock
  återstår. Sortering i listan sker på `DelPri`, sedan körsätt, sedan ordernummer.
- Kontrollera verkliga `Txt`-värden och en order efter Pindeliver mot Visma
  innan snabb- eller massutskrift aktiveras. Alla order är fortsatt åtkomliga i
  vanliga orderfliken även om snabbgrupperingen inte känner igen ett körsätt.
- I läsvyn kan användaren nu markera enstaka klara order eller alla klara i den
  synliga listan och granska ordningen samt status för följesedel/partibilaga.
  Order som saknar dokument eller inte är färdigplockade kan inte markeras.
  Urvalet nollställs vid datumbyte, uppdatering, ny sökning och byte av avgång.
  Granskningen skapar varken PDF-förhandsvisning eller utskriftsjobb.

### Snabbutskrift senare (beslutad interaktion)

- Klick på kortytan Tidig/FM/EM öppnar orderuppslaget för enstaka urval.
- Den separata knappen längst ner ska bli **Skriv ut väntande (N)** och ta alla
  färdigplockade order i avgången som har både följesedel och partibilaga men
  behöver utskrift eller återutskrift. Redan utskrivna order ska inte följa med.
- `Klara/total` och `N att skriva ut` är olika mått och får inte blandas ihop.
- Aktivera inte knappen förrän verkliga Visma-order, regnummer efter Pindeliver,
  buntordning och dokumentparet har verifierats.

### Fraktdokumentgranskning i nuvarande läsvy

- Kyl & Frys, DSV Finland och Eriksson kan välja en order i taget eller alla
  order med tillgängligt fraktdokument i den synliga listan. Granskningen visar
  ordningen efter leveransprioritet och dokumentstatus men skapar ingen utskrift.
- `FreeInf1.Txt1` och `Txt2` visas på skilda rader som **Kylt** respektive
  **Fryst**. Det är fortfarande en order i räknare och urval. Bokningsnummer
  kan också sökas i det allmänna ordersöket.
- Best Transport och Övriga Åkerier har enbart avgångslista, utan dokumenturval.
- Granskningsknappen kontrollerar om urvalet mot serverns aktuella orderdata
  via `/api/dashboard/freight-plan`. Fel grupp, saknat dokument eller försvunnen
  order stoppar hela planen. Planen innehåller endast fraktdokumenttypen och
  skapar inget utskriftsjobb. Den generella utskriftsvägen lägger till
  obligatoriska dokument och får inte kopplas direkt till fraktrutorna.
- En separat fraktpaketsbyggare finns nu för nästa etapp. Den tar endast den
  fraktdokumenttyp som den validerade planen anger och vägrar använda en ändrad
  dokumentgeneration. För Kyl & Frys/Eriksson måste PDF:ens sidgrupper vara
  analyserade innan den bygger etikett- och fraktsedelssektioner. Funktionen
  är ännu **inte kopplad till utskriftsjobb**.
- PDF-kontrollen i uppslaget läser nu de valda filerna via
  `/api/dashboard/freight-packet-check` och visar verifierad sidordning.
  Saknade/okända etikett- eller fraktsedelssidor ger fel och inget utskriftsjobb.
  Mockfilerna `900001`–`900005` har uttryckligen fiktiva testetiketter och
  testsedlar; riktig mall och sidtolkning måste provas mot riktiga dokument.
- Mockorder `900001` på `2026-06-24` har två fiktiva bokningsnummer för att
  kontrollera uppdelningen. Kontrollera verklig Visma-data före utskrift.
- Mockorder `900003` (07:00) och `900002` (16:00) samma datum visar att
  Eriksson filtreras med `DelMt=25` och sorteras efter `DelPri`.
- Mockorder `900004` (rutt 47, 07:00) och `900005` (rutt 48, 13:00) visar
  DSV-urval med separata bokningsnummer. Den befintliga regeln om fyra kopior
  av fraktsedeln baseras nu på leverantörsnummer `50063993`, inte dess namn.
  PDF-kontrollen är läsning/granskning; den gör inga faktiska kopior eller utskrifter.

## NShift i första fasen

Riktig fraktdokumentutskrift begränsas först till de befintliga
Visma–nShift-flödena för Kyl & Frys och DSV Finland. Eriksson grupperas
separat i dashboarden men använder samma Kyl & Frys-flöde. Best Transport och
Övriga Åkerier är tills vidare enbart avgångsöversikter.

## Nästa prioritet efter verifierad manuell utskrift: automatisk fraktdokumentutskrift

När nya Printward fungerar med manuell utskrift ska automatisk utskrift vid
orderstopp vara **första nya funktionen att utreda och bygga**. Inget SQL-jobb,
schema eller automatisk utskrift är aktiverat ännu.

- Fastställ orderstopp per körsätt/avgång och leveransdag. Det får inte vara en
  enda körning för alla åkerier: vissa Kyl & Frys-avgångar har orderstopp samma
  dag. Inkludera först de verifierade fraktgrupperna Kyl & Frys, DSV Finland
  och Eriksson (`DelMt=25/49`); Best och Övriga Åkerier saknar fortfarande
  verifierat utskriftsflöde.
- En schemalagd körning (SQL Server Agent eller separat Printward-jobb beslutas
  senare) ska bara *be Printward* skapa utskriftsjobb. SQL får inte själv märka
  dokument som utskrivna eller anropa nShift/skrivare direkt.
- Läs om aktuell order, PDF och utskriftsstatus precis före köläggning. Hoppa
  över exakt dokumentversion som redan är `printed`. Reservera samma
  order/dokumenttyp/källa/objekt/generation atomiskt så manuell och automatisk
  körning inte kan skapa dubbla jobb samtidigt. Ett jobb som bara är `created`
  är inte utskrivet; `printed` ska sättas först efter bekräftelse från agenten.
- Fel och avbrott ska vara synliga och säkert kunna provas igen. Börja med
  förhandsvisning/dry-run av *vad som skulle skrivas ut* och testa sedan mot
  riktiga order och dokument på kontoret innan schemaläggning aktiveras.
- Besluta separat om en **ändrad** PDF (`reprint`) ska skrivas ut automatiskt
  eller kräva manuell granskning. Regeln "redan utskriven = hoppa över" gäller
  endast samma dokumentgeneration.

## Övriga åkerier och export

Jansen visas i en femte, neutral fraktsedelsruta med namnet
`Övriga Åkerier`. Rutan visar aktuell eller nästa exportavgång:

`Jansen Logistic · Tyskland · rutt 52 · Måndag/torsdag`

Rutan kan rymma framtida destinationer, till exempel England, efter klick på
`Visa avgångar`. Den ska tills vidare bara erbjuda den översikten, inte
utskrift eller varningssiffra.

## Öppet för Jansen Logistic

Bekräfta vilket leverantörsnummer, dokumentmall och dokumenttyp som gäller.
Till dess ska rutt 52 vara en synlig, neutral avgångsrad utan utskriftsknapp.
