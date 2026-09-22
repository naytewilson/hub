#!/bin/sh
set -eu

image="paseo-hub-phase-zero-smoke"
container="paseo-hub-phase-zero-smoke-$$"
database="paseo-hub-phase-zero-postgres-$$"
network="paseo-hub-phase-zero-smoke-$$"

cleanup() {
  podman stop "$container" "$database" >/dev/null 2>&1 || true
  podman network rm "$network" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

podman build --tag "$image" .
podman network create "$network" >/dev/null
podman run --detach --rm --name "$database" --network "$network" \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=paseo_hub \
  docker.io/library/postgres:17-alpine >/dev/null

attempt=0
until podman exec "$database" pg_isready --username postgres --dbname paseo_hub >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    podman logs "$database"
    exit 1
  fi
  sleep 1
done

podman run --detach --rm --name "$container" --network "$network" \
  --env "DATABASE_URL=postgres://postgres:postgres@$database:5432/paseo_hub" \
  --publish 127.0.0.1::3000 \
  "$image" >/dev/null

port="$(podman port "$container" 3000/tcp | sed 's/.*://')"
attempt=0
until curl --fail --silent "http://127.0.0.1:$port/health" | grep --quiet '"ok":true'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    podman logs "$container"
    exit 1
  fi
  sleep 1
done
