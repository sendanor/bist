# Code Cookbook – jatkokehitysprompti paikalliselle Codexille

Toimi Code Cookbookin jatkokehittäjänä. Avaa olemassa oleva projekti, varmista lähtötila ja tee alla kuvattu työ paikallisessa Git-haarassa. Käyttäjä haluaa ensin mahdollisimman kattavat Prettier- ja ESLint-asetukset ja sen jälkeen arvioida, miten lähetettyjen reseptien testit voidaan suorittaa erillisessä ympäristössä ja käyttää tulosta automaattiseen hylkäykseen.

## Lähdekoodi ja käytössä oleva testiasennus

- Cloud-työtilan Git-checkout on `/workspace/sites/adaptable-code-cookbook`. Polku kuuluu aiempaan Codex-ympäristöön. Paikallisella koneella käytä olemassa olevaa checkoutia tai pura toimitettu `code-cookbook-source-b009f16.zip`. ZIP sisältää commitin versionoidun lähdekoodin kansiossa `code-cookbook/`. Git-historia, riippuvuudet, salaisuudet ja tuotantodata eivät sisälly vientiin.
- Varmistettu lähtöcommit on `b009f166509e059aee076615ae05a45e0bc9bbd0`. Se vastaa Sitesin julkaistua versiota 7, jonka deployment onnistui ja jossa MCP on käytössä. Cloud-checkoutissa ei ollut pysyvää Git-remotea. Jos tarvitset alkuperäisen Git-historian tai päivitysoikeuden, hae nykyisen Sites-projektin lähderepositorion käyttöoikeus Sitesista. ZIPistä voi aloittaa myös uuden paikallisen Git-historian.
- Aiempi yksityinen ChatGPT Sites -testiasennus näkyy ChatGPT:ssä nimellä **Code Cookbook**. Testiasennuksen osoite ja tunnisteet löytyvät alkuperäisestä yksityisestä luovutusaineistosta.
- Paikallinen, Gitissä ohitettu `.openai/hosting.json` kytkee Worker-julkaisun olemassa olevaan projektiin ja määrittää `DB`-sidoksen sekä MCP-ominaisuuden. SQL-migraatiot ovat `drizzle/`-hakemistossa. `MAINTAINER_EMAILS` on ajonaikainen, pilkulla erotettu ylläpitäjien sähköpostilista. Käytä paikallisia testitunnuksia. Säilytä testiasennuksen yleisö ja tuotantodata. Käsittele julkaisu erillisenä vaiheena käyttäjän pyytäessä sitä.

## Tuote ja nykyinen toteutus

Code Cookbook on jaettu TypeScript-reseptikirjasto ihmisille ja koodausagenteille. Agentti löytää pienikokoisen ratkaisun, hakee vain tarvitsemansa osat, sovittaa ratkaisun omaan projektiin ja voi tuoda parannuksen takaisin ihmisen katselmoitavaksi. Verkkosivu ja MCP käyttävät samaa TypeScript Workeria ja D1-tietokantaa.

1. **Löydä ja hae.** Hae julkaistuja reseptejä tekstillä tai tageilla. `search_recipes` palauttaa yhteenvedot. `get_recipe` hakee valitut osat ja oletuksena nykyisen julkaistun revision. Kirjoittaja voi hakea oman luonnoksensa tunnisteella.
2. **Lähetä revisio.** `submit_recipe` tallentaa kerralla yhden itsenäisen tiedostokokonaisuuden. Pakollinen osa on `source`. Muut osat ovat `interface`, `tests`, `documentation` ja `instructions`. Parannus ilmoittaa `base`-revision ja sisältää myös säilytettävät osat. `my_revisions` listaa kirjoittajan revisiot. Osakohtainen raja on 12 000 UTF-8-tavua ja JSON-pyynnön raja 96 000 tavua. Tiedostosisältö säilyy revisiokohtaisena.
3. **Katselmoi ja julkaise.** Ylläpitäjä hyväksyy tietyn revision tai pyytää muutoksia. Julkaisu on erillinen toimenpide. Uusi revisio tarvitsee uuden hyväksynnän. Karanteeni poistaa revision saatavilta välittömästi. Oman katselmoimattoman ja julkaisemattoman luonnoksen voi poistaa itse. Suojattu poisto tarvitsee perustellun pyynnön ja ylläpitäjän päätöksen.

Reseptinlukija on yksi vieritettävä sivu järjestyksessä dokumentaatio, julkinen rajapinta, lähdekoodi, testit ja agenttiohjeet. Mukana ovat osiohypyt, turvallisesti renderöity Markdown, TypeScriptin syntaksikorostus, rivinumerot, rivien rivitys, kopiointi ja osiokohtainen muutosvertailu. Mobiilissa päävalikko on alhaalla ja työpöydällä sivupalkissa. Aiemmassa pilvityössä `bounded-line-diff` ja `bounded-json-object-reader` lähetettiin MCP:llä katselmointiin. Niiden tämänhetkinen tila selviää testiasennuksesta.

## Paikallinen lähtötilan tarkistus

Käytä Node.js 24:ää ja lukittuja riippuvuuksia. Lähtöcommitilla ajettiin 21.11.2026 onnistuneesti `npm run check` ja `npm test`.

```bash
npm ci
npm run check
npm test
```

`npm test` ajaa apufunktioiden testit, kokoaa Worker-paketin ja ajaa `scripts/smoke.mjs`-testit Miniflarella. Smoke-testin D1 on paikallinen. Se tarkistaa muun muassa asetusten käyttöoikeudet, lintin estot ja varoitukset, muotoilun, katselmoinnin, julkaisun, valikoivan MCP-haun ja tietojen säilymisen ajon uudelleenkäynnistyksessä. Testi suorittaa repossa olevan tunnetun fixture-testin erillisessä kuluttajaprojektissa. Käytä samassa prosessissa vain luotettuja testifixtureja. Selaintestausta varten kokoa Worker ja käytä paikallista D1:tä sekä synteettistä käyttäjäidentiteettiä paikallisen testipalvelimen kautta.

Keskeiset tiedostot:

| Tiedosto | Vastuu |
| --- | --- |
| `src/index.ts` | Worker-reititys, tunnistus, JSON API ja tilaton MCP |
| `src/store.ts` | D1, reseptit, revisiot, katselmointi ja koodipolitiikan tallennus |
| `src/code-policy.ts` | Asetusluettelo, oletukset, ESLint-sääntöjen nimet ja skeemavalidointi |
| `src/format.ts` | TypeScriptin formatointi, ESLint-ajo ja diagnostiikka |
| `scripts/build.mjs` | Selaimen ja Workerin paketointi, TypeScript-parserin tokenien käyttöönotto |
| `src/browser.js`, `src/page.html`, `src/styles.css` | Käyttöliittymä, asetukset ja reseptinlukija |
| `drizzle/`, `scripts/smoke.mjs` | Migraatiot ja Worker-tason regressiotestit |

## Tehtävä 1 – selvitä ja täydennä Prettier- ja ESLint-yhteensopivuus

Tällä hetkellä Settingsissä on 18 Prettier-muotoiluvalintaa. ESLintillä on JSON-editori kentille `rules`, `globals` ja `settings`. Käytössä on 292 sääntönimeä sisältävä ESLint 9.39.2:n ydinkatalogi, sääntökohtaiset optiot ja `off`-, `warn`- ja `error`-tasot. Katalogissa näkyminen pitää erottaa todennetusta toiminnasta TypeScript-parserilla. Nykyinen lähtöoletus on `no-debugger: error`. Säilytä aiemmin tallennetut boolean-arvot yhteensopivina. Prettier tallentaa muotoillun TypeScriptin. Lint tarkistaa lähetetyn koodin ja raportoi osan, rivin, sarakkeen ja säännön. Virhe estää tallennuksen. Varoitus palautetaan lähettäjälle.

- Selvitä lukittujen versioiden Prettierin ja ESLintin virallisista asetusskeemoista tarkka kattavuus. Tee koodiin ja asetusten käyttöliittymään näkyvä ero tuettujen, ympäristön määräämien ja vielä toteuttamattomien valintojen välille. Torju tuntemattomat tai yhteensopimattomat asetukset täsmällisellä virheilmoituksella.
- Käy läpi Prettierin CLI- ja IDE-kohtaiset valinnat, koko tiedoston muotoilun kanssa ristiriitaiset ohitusehdot, parserin ja tiedostopolun merkitys ja hallittu lisäosatuki. Käytä sisäänrakennettua TypeScript-parseria reseptien oletuksena. Pidä koko tiedoston formatointi käytännössä toimivana myös vanhoilla asetuksilla.
- Käy läpi ESLintin flat configin turvallisesti tuettavat osat, mukaan lukien `languageOptions`, osakohtaiset `files`- ja `ignores`-rajaukset ja sääntöasetusten yhdistäminen. Projektia tai type-aware linttausta vaativat säännöt tarvitsevat oman toteutuspolun. Päätä tuettavuus todellisen Worker-kokeen perusteella. Jos laajennuksia tarvitaan, käytä kiinteästi paketoituja ja erikseen hyväksyttyjä laajennuksia.
- Nykyinen Worker käyttää Prettier standalonea (3.10.1), `eslint-linter-browserify`-paketin legacy APIa, deklaratiivista `jsonschema`-validointia ja TypeScriptin scope manageria. ESLintin flat configin sisäinen skeemakäännös yritti ajonaikaista koodigenerointia ja epäonnistui workerdissä. Nykyinen tokenit päälle kytkevä build-muunnos on sidottu Prettier-version sisäiseen toteutukseen ja pysäyttää buildin, jos odotettu kohta muuttuu. Tarkista päivityksissä AST, tokenit, scope, skeemavalidointi ja Worker-yhteensopivuus yhdessä.
- Varmista yhteinen asetusten käsittely verkko- ja MCP-lähetyksissä, asetusten pysyvyys, ylläpitäjäoikeudet, vanhojen konfiguraatioiden luku ja rividiagnostiikka. Lisää regressiotestejä tapauksille, joita nykyinen smoke-testi ei kata. Käytä esimerkeissä tunnettuja turvallisia TypeScript-fixtureja.
- Pidä asetukset datana. Palvelu käyttää luotettua, buildissä lukittua työkaluvalikoimaa ja Workerin nykyistä eristystä. Ohitusdirektiivit käsitellään palvelun politiikan mukaan. Käyttöliittymän tulee kertoa, mikä kenttä tai sääntö aiheuttaa virheen.

## Tehtävä 2 – suunnittele erillinen testiajo ja tee paikallinen integraatioprototyyppi

ChatGPT Sitesin dokumentoidussa manifestissa ei ole Cloudflare Dynamic Workersin vaatimaa Worker Loader -sidosta. Tämänhetkinen ehdotus on erillinen Cloudflareen julkaistava testiajopalvelu, johon Sites lähettää rajatun HTTPS-pyynnön. Testiajopalvelu on avoin kehitystehtävä. Varmista nykyinen alustatuki ennen käyttöönottoa ja tee paikallinen integraatiotesti simuloidulla vastauksella. Käytä erillistä toteutushaaraa, jos työn laajuus sitä edellyttää.

- Määrittele lähetyksen sopimus tarkan revision tai sen sisältötiivisteen ympärille. Päätä, missä vaiheessa suoritus käynnistetään ja miten uusintayritys palauttaa saman työn tilan. Suunnittele luotetun runnerin ja Cookbookin välille todennettu palveluyhteys.
- Suunnittele yksi kertakäyttöinen suoritusympäristö per ajo. Varmista, että testikoodille ei välitetä Cookbookin salaisuuksia, D1-yhteyttä, muita palvelusidoksia tai verkko-oikeuksia. Rajaa CPU-aika, kokonaiskesto, tuloste ja samanaikaiset työt. Testaa eristyksen ominaisuudet varsinaisella isännöidyllä alustalla ennen kuin suoritat käyttäjien lähettämää koodia.
- Erota onnistunut testi, testin todellinen epäonnistuminen ja infrastruktuurivirhe. Käytä automaattista estoa tai hylkäystä vain täsmällisesti yksilöidylle revisiolle ja vahvistetulle testivirheelle. Jätä infrastruktuurivirhe uudelleenyritykseen. Säilytä ihmisen hyväksyntä ja erillinen julkaisu.
- Kirjoittajan omat testit tarkastavat vain hänen määrittelemänsä tapaukset. Ylläpitäjän omat testit tai tarkistukset ovat erillinen mahdollisuus yhteisten vaatimusten valvontaan. Aloita resepteistä, joiden testit voidaan suorittaa pienellä ennalta määritellyllä testirajapinnalla ilman verkosta asennettavia riippuvuuksia.

Kun työvaihe valmistuu, raportoi muutokset, suoritetut testit, todellinen asetuskattavuus ja jäljellä olevat käyttöönottoedellytykset. Pidä reseptiformaatti itsenäisenä ja säilytä nykyinen verkkosivu- ja MCP-työnkulku.
