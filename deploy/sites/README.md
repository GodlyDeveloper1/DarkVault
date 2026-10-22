# Other sites on the same server

Caddy (deploy/Caddyfile) also serves every `*.caddy` file in this folder, so
one server can host other apps next to Dark Vault under the same certificates
set-up. These files are not committed.

Shielded Quest, for example, ships `deploy/quest.caddy`. On the server:

    cp /opt/shieldedquest/deploy/quest.caddy /opt/darkvault/deploy/sites/
    docker compose -f docker-compose.yml -f deploy/caddy.yml restart caddy

The app behind a site must be on this project's `front` network (Shielded
Quest's deploy/hosted.yml joins it).
