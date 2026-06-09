# Pipeline — Labelisation des communes par date d'obligation d'information

## Objectif

Enrichis le fichier `communes_littorales.geojson` avec la date exacte à partir
de laquelle l'obligation d'information sur le risque d'érosion côtière s'applique
à chaque commune.

## Contexte

L'obligation d'information ne s'applique pas à la même date pour toutes les communes.
Elle est déclenchée par l'inscription de la commune sur la liste fixée par décret,
et non par la loi elle-même. Il faut donc labeliser chaque commune avec sa date
d'entrée en vigueur réelle, pas une date unique nationale.

## Règle de labelisation

Pour chaque commune, `obligation_date` = date de publication au Journal Officiel
du décret qui l'a inscrite pour la première fois sur la liste.

| Vague | Décret | Date JO | `obligation_date` | Remarque |
|---|---|---|---|---|
| 1 | n°2022-750 | 29 avril 2022 | `"2023-01-01"` | L'obligation d'information dans les annonces n'entrait en vigueur qu'au 1er janvier 2023, quel que soit le décret d'inscription |
| 2 | n°2023-698 | 31 juillet 2023 | `"2023-07-31"` | |
| 3 | n°2024-531 | 10 juin 2024 | `"2024-06-10"` | |
| 4 | décret fin 2024 | à préciser au JO | `"2024-MM-DD"` | Cherche sur Légifrance (voir sources) |
| 5 | n°2026-95 | 13 février 2026 | `"2026-02-13"` | |

Les communes hors liste n'ont pas d'obligation → `obligation_date: null`

## Champs à ajouter dans le GeoJSON

```json
{
  "properties": {
    "insee": "...",
    "nom": "...",
    "obligation_date": "2023-01-01",
    "decret": "2022-750",
    "vague": 1
  }
}
```

- `obligation_date` : date ISO à partir de laquelle l'obligation s'applique
- `decret` : numéro du décret d'inscription (ex: `"2022-750"`)
- `vague` : numéro de vague (1 à 5) pour faciliter le filtrage dans l'UI

## Sources — textes officiels sur Légifrance

Télécharge les annexes de chaque décret pour extraire la liste des codes INSEE :

- **Vague 1** — décret 2022-750 :
  https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000045730064
- **Vague 2** — décret 2023-698 :
  https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000047924551
- **Vague 3** — décret 2024-531 :
  https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000049649919
- **Vague 4** — décret fin 2024 :
  Cherche sur https://www.legifrance.gouv.fr avec la requête
  `"décret modifiant décret 2022-750 érosion littoral 2024"`
- **Vague 5** — décret 2026-95 :
  https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000051167195

Utilise le **code INSEE** comme clé de jointure avec le GeoJSON existant.

> ⚠️ Certaines communes ont fusionné entre 2022 et 2026. Si une jointure échoue,
> vérifie avec la table de correspondance COG INSEE :
> https://www.insee.fr/fr/information/2560452

## Calcul du signal de marché dans scatter.json

Dans `scatter.json`, le calcul de `price_delta_pct` doit utiliser
`obligation_date` comme pivot **individuel** pour chaque commune — pas une date globale.

```
avant = transactions où date_mutation < obligation_date
après = transactions où date_mutation >= obligation_date

price_delta_pct = (prix_median_apres - prix_median_avant) / prix_median_avant * 100
```

### Données insuffisantes

Exclure du calcul les communes dont `obligation_date` est trop récente pour
avoir suffisamment de transactions des deux côtés du pivot.

Seuil minimum : **20 transactions avant ET 20 transactions après.**

Ces communes n'apparaissent pas silencieusement exclues du scatter :
elles y figurent avec un champ `"data_quality": "insufficient"` et un
marqueur visuel distinct dans l'UI.
