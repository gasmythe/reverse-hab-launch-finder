# Reverse HAB Launch Finder - Debug + Fallback Version

This version helps debug the live predictor API and keeps the app usable if the live API is blocked.

## Structure

```text
package.json
server.js
README.md
public/
  index.html
```

## Render settings

Build command:

```text
npm install
```

Start command:

```text
node server.js
```

## Environment variable

Set this in Render if needed:

```text
TAWHIRI_API_URL=https://predict.sondehub.org/api/v1/
```

## Test after deploy

Open:

```text
/YOUR_RENDER_URL/health
```

It should say:

```text
Reverse HAB wrapper debug/fallback version is running.
```

Then open the main URL and click:

```text
Test one live prediction
```

If the live predictor is blocked, the app will still run the reverse search using the simple fallback model.
