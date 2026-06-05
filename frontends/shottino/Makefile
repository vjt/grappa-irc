ROOT := ../..
-include $(ROOT)/config.mk

CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Wpedantic -O2
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L
PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
CFLAGS += $(CFLAGS_DEPS)
LDLIBS += $(LDLIBS_DEPS)

BIN := shottino
SRC := shottino.c

.PHONY: all install clean

all: $(BIN)

$(BIN): $(SRC)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $< $(LDLIBS)

install: $(BIN)
	install -d "$(DESTDIR)$(BINDIR)"
	install -m 0755 "$(BIN)" "$(DESTDIR)$(BINDIR)/$(BIN)"

clean:
	rm -f $(BIN)
