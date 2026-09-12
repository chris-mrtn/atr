# atr

Website for the movie club: what we've watched, and whose turn it is to pick.

Static site, no build step, no dependencies. Published with GitHub Pages.

## Updating it

Everything on the page comes from [`data/club.json`](data/club.json). Edit that
file, commit, push — Pages redeploys in a minute or so.

### After a screening

Add the film to `archive` and set `lastPickedBy` to whoever chose it. The site
sorts the archive by date itself, so it doesn't matter where in the list you
add the entry.

```json
{
  "title": "Chungking Express",
  "year": 1994,
  "director": "Wong Kar-wai",
  "watchedOn": "2026-08-21",
  "pickedBy": "Priya"
}
```

Only `title` is required. `watchedOn` is `YYYY-MM-DD`.

### Whose turn

The next picker is whoever follows `rotation.lastPickedBy` in `rotation.order`,
wrapping at the end. To change the running order, reorder `rotation.order`.

## Running locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 — it needs to be served over HTTP, because
opening `index.html` from disk blocks the JSON fetch.

## Layout

```
index.html          markup and element hooks
assets/styles.css   all styling; light and dark
assets/app.js       loads club.json and renders the page
data/club.json      the only file you need to edit
```
