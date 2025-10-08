# Design Signature Timeline

Design Signature Timeline is a self-contained web app for turning collaborative design conversation transcripts into an interactive timeline. The static front-end lets you review each utterance, tag it as problem or solution oriented, and explore aggregate views. An accompanying Azure Functions endpoint batches snippets and calls Anthropic's Claude model to suggest process categories, helping teams analyze design discussions faster.

## Repository structure

```
.
├── index.html                 # Single-page interface with timeline visualization and tagging UI
├── staticwebapp.config.json   # Static Web Apps routing and runtime configuration
└── api/
    ├── package.json           # Azure Functions dependencies
    └── categorize/            # "categorize" HTTP-triggered function
        ├── function.json
        └── index.js
```

## Features

- **Interactive transcript review** – Scrollable chat-style transcript with quick editing tools and synchronized timeline.
- **Process timeline visualization** – Parallel axes show speaker activity and problem/solution categorization over time.
- **AI-assisted tagging** – `/api/categorize` batches transcript snippets and classifies them as `PROB`, `SOLN`, or unspecified using Anthropic Claude.
- **Request throttling** – Global and per-user quotas prevent abuse; anonymous users receive a higher hourly allowance.
- **Debug modes** – Environment flags let you disable API calls or inspect prompts/responses while developing.

## Getting started

### Prerequisites

- [Node.js 20+](https://nodejs.org/) for running the Azure Function locally.
- An [Anthropic API key](https://docs.anthropic.com/claude/docs/getting-access-to-the-api) with access to Claude 3 Haiku.

### Install API dependencies

```bash
cd api
npm install
```

### Configure environment

The function reads the following environment variables:

| Variable | Description |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. Claude API key used when classifying snippets. |
| `DEBUG_MODE` | Optional. Set to `true` to skip external API calls and return empty categories. |
| `DEBUG_API` | Optional. When `DEBUG_MODE` is `true`, setting `DEBUG_API=true` forces real API calls and appends the raw prompt/response to the payload for inspection. |

Create a local `.env` file or export these variables in your shell before running the function.

### Run the Azure Function locally

You can run the HTTP-triggered function with the Azure Functions Core Tools:

```bash
# from the repository root
cd api
npx azure-functions-core-tools@4 start
```

The function listens on `http://localhost:7071/api/categorize` by default. Send a `POST` request with JSON of the form:

```json
{
  "entries": [
    {"text": "We need to gather more requirements from the client."},
    {"text": "Let's brainstorm possible design alternatives."}
  ]
}
```

The response contains a `results` array with `{ "text", "category" }` pairs.

### Serving the front-end

The front-end is a single HTML file. For local testing you can open `index.html` directly in a browser or serve it with any static server, for example:

```bash
npx http-server -p 4280
```

Update the front-end configuration (if necessary) to point API requests at your local or deployed function endpoint.

### Azure Static Web Apps workflow

This repository is structured for [Azure Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/overview):

- Place static assets in the repository root (default output location).
- Put Azure Functions under the `api/` directory. The included `staticwebapp.config.json` allows anonymous access and specifies the Node.js runtime for the backend.

To emulate the full stack locally with the Static Web Apps CLI:

```bash
npm install -g @azure/static-web-apps-cli
swa start http://localhost:4280 --api-location api
```

Then visit `http://localhost:4280` in your browser.

## Deployment tips

1. Create a Static Web App in Azure and configure the deployment source (GitHub Actions, Azure DevOps, etc.).
2. In the Static Web App configuration, add an application setting named `ANTHROPIC_API_KEY` with your Claude key.
3. Deploy the repository; Azure builds the static site and provisions the function app automatically.
4. Monitor function logs to verify successful classification responses.

## Contributing

1. Fork the repository and create a feature branch.
2. Make your changes and add tests or manual verification steps when applicable.
3. Submit a pull request describing the changes and expected behavior.

## License

Specify your chosen license here (e.g., MIT, Apache 2.0). Update this section if a license file is added to the project.
