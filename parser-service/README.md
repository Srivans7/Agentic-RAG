Parser microservice

Quick start:

- Install dependencies: `npm ci`
- Run locally: `npm start` (listens on :3001)
- Endpoint: `POST /parse` with raw file bytes as body. Returns `{ text: string }`.

Deploy: host this service on Railway/Render/Heroku or in a Docker container using the included `Dockerfile`.

Set `PARSER_SERVICE_URL` in your main app to the deployed service URL (e.g. `https://my-parser.example.com`).
