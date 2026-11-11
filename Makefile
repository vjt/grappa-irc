# Builds shottino, and only shottino: every target is forwarded to
# frontends/shottino/Makefile, so a target works the same from the repo
# root as from there (#2587 — `make call` at the root used to be no rule).
SHOTTINO_DIR := frontends/shottino

.PHONY: all shottino install clean call check

all: shottino

shottino:
	$(MAKE) -C $(SHOTTINO_DIR)

install clean call check:
	$(MAKE) -C $(SHOTTINO_DIR) $@
