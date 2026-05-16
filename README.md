# Reverse HAB Launch Finder - Tawhiri Wrapper

This is a starter "reverse search wrapper" for high-altitude balloon launch planning.

Instead of building a weather model from scratch, this app:
1. Takes a desired landing coordinate.
2. Generates possible launch points around that target.
3. Sends each launch point to a Tawhiri/SondeHub-style forward predictor API.
4. Compares each predicted landing point to your target.
5. Shows the best launch options on a map.

## Important

This is experimental and educational. Do not use it as a final flight-safety tool. For a real launch, confirm using normal prediction tools and check permissions, airspace, roads, water, terrain, power lines, weather, recovery access, and local regulations.

## Deploy on Render

1. Create a free Render account.
2. Click **New +**.
3. Choose **Web Service**.
4. Upload this folder to a GitHub repo, then connect the repo to Render.
5. Render settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
6. Optional environment variable:
   - `TAWHIRI_API_URL=https://predict.sondehub.org/api/v1/`
7. Deploy.
8. Open your Render URL.
9. In Google Sites, use **Insert → Embed → By URL** and paste your Render URL.

## Local Testing

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Notes

- Start with a coarse search: radius 120 km, grid step 20 km, max predictions 60.
- Finer searches use more API calls and may be slower.
- If the public predictor endpoint changes, update the `TAWHIRI_API_URL` environment variable.
