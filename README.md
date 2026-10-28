# crud_ai

A CRUD application with AI capabilities built in. It is a reference project for combining standard Create / Read / Update / Delete workflows with AI features such as natural-language querying, content generation and summarisation.

> **Status:** early stage. The repository currently contains documentation only. Sections marked **TODO** are to be filled in as the implementation lands.

## Goals

- Provide a clean, full-stack CRUD baseline (API, persistence, UI).
- Add AI features on top of that baseline, for example:
  - natural-language search and filtering of records
  - auto-generated summaries, descriptions and tags
  - an assistant that can create or update records from plain-language requests
- Keep the design simple and layered so each part can be swapped or extended (design patterns, cloud deployment, architecture experiments).

## Architecture (planned)

```
┌────────────┐     REST/JSON     ┌──────────────┐      ┌────────────┐
│  Frontend  │ ────────────────▶ │   Backend    │ ───▶ │  Database  │
│ (React/TS) │ ◀──────────────── │ API service  │ ◀─── │            │
└────────────┘                   └──────┬───────┘      └────────────┘
                                        │
                                        ▼
                                ┌──────────────┐
                                │  AI service  │
                                │ (LLM / API)  │
                                └──────────────┘
```

| Layer     | Responsibility                                  | Technology |
|-----------|-------------------------------------------------|------------|
| Frontend  | UI for listing and editing records, AI assistant | TODO       |
| Backend   | REST API, validation, business logic            | TODO       |
| Database  | Persistence of records                          | TODO       |
| AI layer  | Prompting, tool calls, response handling        | TODO       |

## Features

| Feature                              | Status  |
|--------------------------------------|---------|
| Create / read / update / delete      | Planned |
| Search and pagination                | Planned |
| AI summarisation / tagging           | Planned |
| Natural-language queries             | Planned |
| Authentication                       | Planned |

## Getting started

**TODO:** add once the code exists. Expected shape:

```bash
git clone https://github.com/nuycl/crud_ai.git
cd crud_ai
# install dependencies, configure environment, run the app
```

### Configuration

AI provider credentials and database settings will be supplied through environment variables. Never commit secrets; keep them in a local `.env` file that is git-ignored.

| Variable          | Purpose                     |
|-------------------|-----------------------------|
| `DATABASE_URL`    | Database connection string  |
| `AI_API_KEY`      | API key for the AI provider |

(Variable names are provisional.)

## Project structure

**TODO:** document the layout once directories are created.

## Roadmap

1. Choose the stack and scaffold backend and frontend.
2. Implement the CRUD API and UI.
3. Add tests (unit, API, end-to-end).
4. Integrate the first AI feature (summaries / tagging).
5. Add natural-language search and the assistant.
6. Containerise and document cloud deployment.

## Contributing

1. Create a feature branch from the default branch.
2. Make focused commits with clear messages.
3. Open a pull request describing the change and how it was tested.

## License

**TODO:** choose a license.
