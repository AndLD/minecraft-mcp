# Docker: e2e Minecraft server

`e2e-server.env` configures the throwaway Paper 1.21.1 server that the e2e tests run against (offline mode,
superflat world, peaceful, no mob spawning, RCON enabled). The Jest global setup starts it with
`testcontainers` on random ports and stops it afterwards; `docker-compose.e2e.yml` starts the same server
by hand on fixed ports for exploring.

`config/bukkit.yml` turns off Paper's login throttle (the tests log several bots in from one IP quickly).

The first run downloads the image (about 500 MB) and the Paper jar, so it takes a few minutes.
