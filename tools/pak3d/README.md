# Pak 3D: glTF models for the 3D view

A **pak 3D** gives selected objects of a pakset (buildings, vehicles, trees, signs) a glTF model in the
3D view of the browser dashboard ([tools/dashboard](../dashboard/README.md#pak-3d-gltf-models)). It is a
directory of files next to the game, matched to the pak's objects by their **names** (the untranslated
names of `desc_list`, e.g. `RES_65_12`, `TMB_Class_6000`). Everything without a model keeps its generated
look, so a pak 3D can start with one model and grow. The Simutrans-Horizon pak 3D for pak128 is a separate
repository: [simutrans-horizon-pak3d](https://github.com/bdnowicki/simutrans-horizon-pak3d) (CC BY 4.0, every
model made by a Blender Python script).

```
pak3d/
  manifest.json        what is modelled (format 1, below)
  models/*.glb         glTF 2.0 binary (or .gltf + .bin)
  textures/*.png|webp  textures of .gltf files (a .glb embeds its own)
  generator/*.json     optional: categories for the building generator
  LICENSES.md          author and licence of every file
  LICENSE              licence of the pak (CC BY 4.0 for the Simutrans-Horizon pak 3D)
  scripts/             optional: the Blender Python scripts that make the models
```

The bridge serves it with `--pak3d DIR` (or `SIMUTRANS_DASHBOARD_PAK3D`) under `/pak3d/`, behind the session,
only the types `.json .glb .gltf .bin .png .webp .ktx2 .jpg .jpeg .txt .md`.

The tools here need only Python 3 (standard library):

* `check_pak3d.py` checks a pak 3D before it is published (manifest, files, limits, licences);
* `coverage.py` reports which objects of a running game have a model and which do not (the to-do list);
* `pak3dlib.py` is their shared code (the same rules as `tools/dashboard/web/js/scene3d/pak.js`).

## manifest.json

```json
{
  "format": 1,
  "name": "Simutrans-Horizon pak 3D",
  "version": "0.1.0",
  "license": "CC BY 4.0",
  "author": "...",
  "units": {"tile": 1.0, "height_step": 0.2041},
  "entries": [
    {"match": "building:NYC_EmpireState", "model": "models/empire_state.glb", "lod": ["models/empire_state_lod1.glb"],
     "featured": true, "footprint": [2, 2]},
    {"match": "building:RES_65_12", "model": "models/res_65_12.glb"},
    {"match": "building:*", "type": "res", "climate": "desert", "generator": "adobe"},
    {"match": "building:FakeStop"},
    {"match": "vehicle:TMB_Class_6000", "model": "models/tmb6000.glb", "player_color": ["Body"], "length": 0.5},
    {"match": "tree:tree03?", "model": "models/tree_{season}.glb", "variants": {"season": ["summer", "winter"]},
     "scale_by_age": true},
    {"match": "sign:Oneway_sign", "model": "models/oneway.glb"}
  ],
  "generators": {"adobe": "generator/adobe.json"},
  "rules": {"trees": {"colors": {"conifer": ["#2f5a34"]}}}
}
```

**Matching.** `match` is `"<kind>:<name or pattern>"` with kind `building`, `vehicle`, `citycar`, `pedestrian`,
`tree`, `sign` (drawn from models) or `way`, `bridge`, `tunnel`, `wayobj` (accepted and counted, still
generated). In a pattern `*` stands for any text and `?` for one character; names are case-sensitive. For an
object, the entries of its kind with an **exact name** come first (in file order), then the patterns in file
order; the first entry whose name and **filters** fit wins:

| Filter | Value (text or list of texts) | Compared with |
|---|---|---|
| `type` | `res com ind cur mon tow hq stop ext depot factory other` | building type |
| `climate` | `water desert tropic mediterran temperate tundra rocky arctic` | any climate the desc allows |
| `waytype` | `road track tram monorail maglev narrowgauge water air` | desc way type |
| `size` | `[x, y]` | building size of layout 0 |
| `system` | `flat elevated ...` | way system |
| `freight` | goods name, e.g. `Passagiere` | vehicle freight |

**What an entry does.** With `model`, the object is drawn with that model; an entry with `generator` (buildings)
keeps it generated but in the named generator category; an entry with neither keeps the generated look and stops
the search (to exclude one name from a pattern).

| Field | Meaning |
|---|---|
| `model` | path inside the pak (`.glb`/`.gltf`); `{season}` (`summer autumn winter spring`) and `{climate}` (names above) are filled in per object |
| `lod` | up to 4 coarser models: LOD *n* (n = 1, 2, 3) is used while the model is smaller on the screen than buildings 120, 40, 12 pixels, trees 64, 22, 7, signs 48, 16, 5, vehicles 44, 15, 5, city cars 30, 10, 4, pedestrians 22, 8, 3 (times the detail distance of the quality panel: 0.7, 1, 1.5) |
| `variants` | `{"season": [...], "climate": [...]}`: the values that have files (others use the first), or `{"autumn": "summer", ...}` (game value → file value) |
| `player_color` | further material names painted in the company colour (besides `player1`/`player2`) |
| `scale_by_age` | trees: grown trees (age class 4) at model size, young ones down to 0.43 |
| `featured` | higher limits (landmarks, favourite vehicles) |
| `footprint` / `length` | declared size for `check_pak3d.py` (squares; buildings `[x, y]` of layout 0, vehicles the car length) |
| `generator` | buildings: generator category (a key of `rules.categories`) |
| `comment` | ignored |

**Generator rules.** `rules` (an object or the path of a `.json`) is merged over the dashboard's
`web/js/scene3d/gen/rules.json`: objects key by key, arrays and values replaced. Each file of `generators`
holds one category (the same keys as `rules.categories.*`: `types`, `form`, `facades`, `roofs`, ...) and is
merged into `categories.<name>`.

**units.** `tile` = model units per square (1 recommended; models are scaled by 1/tile), `height_step` =
squares per height level, normally 0.2041 (a different value is only a warning: models keep their proportions).

**Errors.** Unknown fields are warnings (logged in the browser console, ignored). Any other problem (wrong format,
a path out of the pak, an unknown kind or climate, `model` with `generator`, ...) makes the dashboard ignore the
whole pak and show the first problems once in the 3D tab; everything is generated then. A model file that is
missing, cannot be read or breaks a limit is logged and its objects are generated.

## Models

* **glTF 2.0**, binary `.glb` preferred (textures embedded). No Draco, meshopt or KTX2 compression (the dashboard
  loads no decoders); no cameras, no lights. Animations of whole nodes (translation, rotation, scale) play in a
  loop, the same for all copies and only while a copy is on the screen; skinned meshes are not drawn (no
  skinning or morph targets).
* **Axes:** +Y up, **1 unit = 1 square**, origin at the **middle of the footprint on the ground** (y = 0 at the
  ground of the building's squares).
* **Buildings** as for **layout 0**: front to **+Z** (south: the side the game shows at the bottom left), +X =
  east (+x of the map). Layouts 1, 2, 3 turn the model by 90°, 180°, 270° (front east, north, west), like the
  game turns city buildings to their street; buildings with 2 layouts use layouts 0 and 1, 8 layouts repeat the
  4 turns. A building of several squares is **one model for the whole footprint** (x by y squares of layout 0),
  placed at the square with offset 0,0 (its north-west square) and drawn by that square's chunk. Keep a few
  hundredths of a square inside the footprint; no floor face at y = 0 (it would flicker with the ground).
* **Vehicles:** front to **+X**, origin in the middle of the car on the rail or road surface, length along X =
  the car length (`length` of `desc_list` / 16 squares, e.g. 8 → 0.5). Cars are drawn at model size, not
  stretched. A powered last car of a convoy is turned round like the generated ones.
* **Trees and signs:** standing on the origin within one square. Signs face **+X** (the side the vehicles see).
* **Materials:** PBR (`MeshStandardMaterial`). Special names: **`player1`** and **`player2`** are painted in the
  first and second company colour of the owner (a base colour texture still multiplies; objects without owner
  keep the material's colour), **`night_emissive`** is the light of windows and lamps at night (dark by day; with
  the day and night option of the 3D view buildings switch it on one after the other as the night falls,
  vehicles and featured models at once). The view has no environment map: keep `metallic` low (≤ 0.3) or
  surfaces look dark.
* **Limits** per file (more for `"featured": true`):

  | Kind | Triangles | Featured |
  |---|---|---|
  | building, way, bridge, tunnel, wayobj | 5 000 | 30 000 |
  | vehicle, city car | 3 000 | 6 000 |
  | pedestrian | 1 000 | 2 000 |
  | sign | 1 000 | 2 000 |
  | tree | 500 | 2 000 |

  Textures at most 1024 × 1024 (featured 2048 × 2048), powers of two recommended. LODs count like models.

### Export from Blender

File → Export → glTF 2.0: **Format glTF Binary (.glb)**; Include: selected objects or visible objects, no
cameras, no punctual lights; Transform: **+Y Up** (the default, Blender's Z becomes Y); Data → Mesh: **Apply
Modifiers**, UVs, normals; Materials: export; Compression off. Apply transforms first (Object → Apply → All
Transforms) so the origin sits at the middle of the footprint on the ground. In Blender coordinates (Z up) that
means: building front towards **−Y** (Blender's front view looks at it), east +X; vehicle front towards **+X**.
One Blender unit = one square (a 1 × 1 building fits in −0.5…0.5). Headless:
`blender -b --factory-startup -P script.py -- --out model.glb` with
`bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True, export_cameras=False, export_lights=False)`.

## LICENSES.md

One Markdown table with the columns `File | Author | License | Source | Notes`; `File` may be a path or a
pattern (`models/tree_*.glb`). Every file the dashboard can serve (all files of the types above except
`LICENSES.md`, `LICENSE*`, `README*`) needs a row with an author. The licence is **CC BY 4.0** (an empty cell
means CC BY 4.0); **CC0** is allowed for imported files and needs its note (source or notes, e.g. where it came
from). The dashboard shows the table on its "Model authors" page (ⓘ button of the 3D view), as plain text.

```
| File | Author | License | Source | Notes |
|---|---|---|---|---|
| models/tmb6000.glb | Jane Doe | CC BY 4.0 | scripts/tmb6000.py | |
| models/tree_*.glb | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/nature-kit | CC0, credit kept as a courtesy |
```

## check_pak3d.py

```
python tools/pak3d/check_pak3d.py PAK_DIR [--descs desc_list.json] [--strict] [--quiet]
```

Checks the manifest (same schema as the dashboard; warnings for unknown fields), the
rules and generator files, every model file each entry can use (all LODs and variants): that it exists and
parses (`.glb` header and JSON chunk, or `.gltf` with its buffer), its triangles against the limit of its kind,
embedded and external texture sizes (PNG, JPEG, WebP headers), no cameras or lights, no extensions that need a
decoder, the bounds after node transforms against the declared `footprint` (buildings: must stay within it plus
0.1 squares, centred) or `length` (vehicles: within 25 %), the lowest point on the ground, material names of
`player_color`; and `LICENSES.md` (every file listed with an author and an allowed licence, CC0 with its note).
`--descs` takes a saved `desc_list` reply (e.g. `/api/desc_list`) and adds footprints and lengths of exact
names and warns about entries that match nothing. Exit code 0 without errors (warnings allowed unless
`--strict`), 1 with errors, 2 when the directory cannot be read. Prints a table of the models (triangles,
materials, special materials, size, textures).

## coverage.py

```
python tools/pak3d/coverage.py --bridge http://127.0.0.1:13380 --token TOKEN [--pak3d DIR] [--extras] [--top 30] [--json OUT]
python tools/pak3d/coverage.py --engine 127.0.0.1:13360 --pak3d DIR
```

Reads every chunk of the map (`scene3d`) and the vehicles (`vehicles3d`, in squares of 256) from a dashboard
bridge (any token, also over the internet) or straight from a game with `-remote_control`, and matches the
objects against the manifest (the one the bridge serves, or `--pak3d`). Prints per kind (buildings by type) how
many object types and copies (buildings counted once per building, trees and cars one by one, ways per square)
have a model, and the objects without one with the most copies first — the to-do list for modellers. `--extras`
also counts city cars and pedestrians; `--json` writes everything. The bridge's rate limits are respected
(about 5 s for a 1024 × 1024 map).
