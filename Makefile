SHOTTINO_DIR := frontends/shottino

.PHONY: all shottino install clean

all: shottino

shottino:
	$(MAKE) -C $(SHOTTINO_DIR)

install:
	$(MAKE) -C $(SHOTTINO_DIR) install

clean:
	$(MAKE) -C $(SHOTTINO_DIR) clean
