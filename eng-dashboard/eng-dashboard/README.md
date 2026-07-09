# Engineering Productivity Dashboard

A full-stack dashboard for monitoring engineering productivity with mock and real GitLab-backed data sources.

## Project structure
- frontend: React + Vite dashboard UI
- backend: Express API and GitLab sync service
- docs: architecture and setup notes

## Quick start

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

## Notes
- The backend can run against mock GitLab data or a real GitLab instance.
- Keep real environment values in .env and do not commit them.
