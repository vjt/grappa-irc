ROOT := ../..
-include $(ROOT)/config.mk

CC ?= cc
# Warnings and hardening are NOT part of the overridable CFLAGS.
#
# `CFLAGS ?=` meant that a CFLAGS in the environment — which build systems,
# distro packaging and `make CFLAGS=-O0` all set — silently deleted -Wall
# and -Wextra along with everything else. The parts that must survive any
# override live in their own variables and are appended below.
#
# The hardening is cheap and this binary parses hostile bytes: websocket
# frames, chunked HTTP and downstream IRC all arrive from somewhere else.
# The sanitizers ride only the TEST binaries, so the shipped one deserves
# the flags that cost nothing. -Wformat=2 is deliberate: every varargs
# helper here already carries __attribute__((format)), so it has something
# to check.
CFLAGS ?= -O2
WARNINGS := -std=c11 -Wall -Wextra -Wpedantic -Wformat=2
HARDENING := -fstack-protector-strong -D_FORTIFY_SOURCE=2
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L
CFLAGS += $(WARNINGS) $(HARDENING)
PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
CFLAGS += $(CFLAGS_DEPS)
LDLIBS += $(LDLIBS_DEPS)

BIN := shottino
OBJS := shottino.o json.o wire.o alias.o mirc.o termcolor.o http.o media.o ircd.o ws.o llm.o

# Test binaries link only the pure modules they exercise — no ncurses, no
# OpenSSL, no terminal. That is the point of keeping the narrowing and
# formatting code free of app state: it stays testable without a TTY.
# test_layout is the ONE exception: it compiles shottino.c itself and
# renders to an offscreen ncurses screen (newterm to /dev/null), because
# the chat area's clipping contract cannot be expressed in a leaf module.
#
# Tests build with ASan+UBSan: this is C, and the parser walks attacker-
# shaped input off the network. A leak or a one-past-the-end read in the
# arena is exactly the class of bug that passes a plain assertion suite and
# corrupts the app hours later. Override SANITIZE= to disable on a toolchain
# without the runtime.
#
# COVERAGE CAVEAT: the sanitizers ride these test binaries only, and the
# `all` binary is built WITHOUT them. shottino.c's own logic — websocket
# framing, event dispatch, app state — is covered only where test_layout
# reaches, which is the drawing primitives and nothing else. Do not trust
# this net for changes elsewhere in that file; add a test or reason about
# the path by hand.
TESTS := tests/test_llm tests/test_ws tests/test_json tests/test_wire tests/test_alias tests/test_mirc tests/test_termcolor tests/test_http tests/test_media tests/test_whip tests/test_callmedia tests/test_callnote tests/test_layout tests/test_keys tests/test_ircd tests/test_commands tests/test_windows tests/test_call
SANITIZE ?= -fsanitize=address,undefined -fno-omit-frame-pointer
TEST_CFLAGS := -std=c11 -Wall -Wextra -Wpedantic -O1 -g $(SANITIZE)

.PHONY: all install clean check

all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $(OBJS) $(LDLIBS)

# -MMD -MP makes the compiler write the header dependencies, because a
# hand-maintained list rots: shottino.o's named nine headers while
# shottino.c included eleven, so editing version.h or llm.h did not
# rebuild it and the binary could ship a version string it no longer had.
%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

-include $(OBJS:.o=.d)

# ws is a pure buffer: bytes in, messages out. It gets the fussiest
# suite in the tree because the bug it replaces was invisible to every
# other one — a frame delivered in pieces.
# llm is bytes-in/JSON-out: config text, request bodies, stream frames.
# Every one of those fails SILENTLY on the wire when a key name is wrong,
# so it gets a suite with no socket and no subprocess in sight.
tests/test_llm: tests/test_llm.c tests/test.h llm.c llm.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_llm.c llm.c json.c

tests/test_ws: tests/test_ws.c tests/test.h ws.c ws.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_ws.c ws.c

tests/test_json: tests/test_json.c tests/test.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_json.c json.c

tests/test_wire: tests/test_wire.c tests/test.h wire.c wire.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_wire.c wire.c json.c

tests/test_alias: tests/test_alias.c tests/test.h alias.c alias.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_alias.c alias.c

# The WHIP signalling parsers. In the DEFAULT gate on purpose: these
# bytes arrive from a URL that came out of an IRC message, so they get
# the same sanitizer treatment as every other parser here. It links
# whip.c and http.c only — NOT the vendored libdatachannel — so the gate
# never depends on the opt-in submodule having been built.
tests/test_whip: tests/test_whip.c tests/test.h call/whip.c call/whip.h http.c http.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_whip.c call/whip.c http.c -lssl -lcrypto

# The media legs are fork+exec and sockets, verified by running them;
# the SDP is the one pure part and the one whose failure is silent.
# Links media.c only — no libdatachannel — so the gate stays independent
# of the opt-in submodule.
tests/test_callmedia: tests/test_callmedia.c tests/test.h call/media.c call/media.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_callmedia.c call/media.c

# The helper's stderr is a PARSED stream with a reader at the other end,
# so what it is allowed to write is a contract and not formatting. Links
# note.c only, for the same reason test_callmedia links media.c only.
tests/test_callnote: tests/test_callnote.c tests/test.h call/note.c call/note.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_callnote.c call/note.c

tests/test_mirc: tests/test_mirc.c tests/test.h mirc.c mirc.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_mirc.c mirc.c

tests/test_termcolor: tests/test_termcolor.c tests/test.h termcolor.c termcolor.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_termcolor.c termcolor.c

tests/test_http: tests/test_http.c tests/test.h http.c http.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_http.c http.c

tests/test_media: tests/test_media.c tests/test.h media.c media.h termcolor.c termcolor.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_media.c media.c termcolor.c

# The only suite that needs the app's own build environment: it includes
# shottino.c, so it takes the same feature-test macros ($(CFLAGS_DEPS),
# which is what puts strcasestr and cfmakeraw in scope) and links what
# shottino links.
tests/test_layout: tests/test_layout.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_layout.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c $(LDLIBS)

# test_keys needs a pty (-lutil): it feeds real byte sequences through the
# client's own key decoding, because every key bug so far has been about
# what the terminal DELIVERS rather than what the handler does with it.
# test_ircd opens a real socket to the bridge and speaks IRC to it: a
# bridge is judged by what a client sees, and that cannot be asserted
# from the inside.
tests/test_ircd: tests/test_ircd.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_ircd.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c $(LDLIBS)

# test_commands reads shottino.c off disk as well as compiling it: the
# invariant it guards is that three lists inside that file agree, and the
# only honest source for "what the dispatcher accepts" is the dispatcher.
tests/test_commands: tests/test_commands.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_commands.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c $(LDLIBS)

# test_windows drives the app's own window bookkeeping — no screen, no
# socket, just state — because "which window does this name mean" is the
# question every other bug in the sidebar has turned out to be.
tests/test_windows: tests/test_windows.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_windows.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c $(LDLIBS)

# test_call is the only suite linked against BOTH binaries: it compiles
# shottino.c for the call helpers and links call/media.c so the codec
# word shottino puts in the helper's argv can be handed to the helper's
# own parser. Asserting that word against a literal here would only say
# what this side already believes.
tests/test_call: tests/test_call.c tests/test.h shottino.c call/media.c call/media.h json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_call.c call/media.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c $(LDLIBS)

tests/test_keys: tests/test_keys.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_keys.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c ircd.c ws.c llm.c $(LDLIBS) -lutil

# `make check` is the gate: build every suite, run every suite, fail loud.
check: $(TESTS)
	@rc=0; for t in $(TESTS); do \
		printf '== %s\n' "$$t"; \
		./$$t || rc=1; \
	done; exit $$rc

# ── shottino-call: the media helper (OPT-IN) ───────────────────────────
#
# NOT built by `make all`, and that is the whole point. The packaging
# path runs `make -C frontends/shottino` and must keep producing ONE
# binary whose runtime deps the bundled ERTS already pulls in (see
# infra/packaging/nfpm.yaml); building this additionally needs cmake and
# a C++ compiler, which the .deb and AUR builders are not asked for.
# `make call` builds it, and nothing else references it.
#
# The four vendored archives link INTO the binary, so the helper ends up
# depending on exactly what shottino already depends on — measured with
# ldd: libssl, libcrypto, libm, libc, libz, libzstd. No libstdc++.
#
# Which needs two things that are easy to get wrong:
#   - it compiles as C11 but LINKS with the C++ driver. libdatachannel
#     is C++ inside, and linking with $(CC) fails on __cxxabiv1 vtables.
#   - -static-libstdc++ -static-libgcc, or the binary picks up a
#     libstdc++.so.6 runtime dependency that was the thing being avoided.
CXX ?= c++
LDC_DIR := vendor/libdatachannel
LDC_BUILD := vendor/build
LDC_LIBS := $(LDC_BUILD)/libdatachannel.a \
            $(LDC_BUILD)/deps/libjuice/libjuice.a \
            $(LDC_BUILD)/deps/libsrtp/libsrtp2.a \
            $(LDC_BUILD)/deps/usrsctp/usrsctplib/libusrsctp.a
CALL_BIN := shottino-call
CALL_SRC := call/main.c call/whip.c call/media.c call/note.c http.c
CALL_CFLAGS := $(CPPFLAGS) $(CFLAGS) -I$(LDC_DIR)/include

.PHONY: call call-compile
call: $(CALL_BIN)

# A checked-out submodule is a precondition with a readable failure. The
# bare cmake error for a missing CMakeLists is not one.
$(LDC_DIR)/CMakeLists.txt:
	@echo "the libdatachannel submodule is not checked out. From the repo root:" >&2
	@echo "  git submodule update --init --recursive \\" >&2
	@echo "      frontends/shottino/vendor/libdatachannel" >&2
	@exit 1

# The share of `call` that a gate can afford (#754). Linking the helper
# costs cmake, a C++ toolchain and minutes of libdatachannel build, so no
# CI or packaging job runs `call` — which left call/main.c, the helper's
# whole main loop and the entire libdatachannel integration, compiled by
# nothing in the tree. Compiling it costs a second: the vendored headers
# are already on disk beside the sources, no archive has to exist, and a
# warning that fails the client build fails here the same way.
#
# What it does NOT cover, deliberately: no link runs, so the C++ link
# driver, -static-libstdc++ and the four archives are still only proven
# by someone typing `make call`.
call-compile: $(LDC_DIR)/CMakeLists.txt
	@for src in $(CALL_SRC); do \
		echo "  CC (compile-only) $$src"; \
		$(CC) $(CALL_CFLAGS) -c -o /dev/null "$$src" || exit 1; \
	done

# USE_GNUTLS=OFF takes the OpenSSL already linked; USE_NICE=OFF takes the
# bundled libjuice rather than adding a system libnice; NO_WEBSOCKET
# because WHIP is plain HTTP and shottino has its own websocket.
$(LDC_LIBS): $(LDC_DIR)/CMakeLists.txt
	cmake -S $(LDC_DIR) -B $(LDC_BUILD) -DCMAKE_BUILD_TYPE=Release \
	  -DBUILD_SHARED_LIBS=OFF -DUSE_GNUTLS=OFF -DUSE_NICE=OFF \
	  -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON
	cmake --build $(LDC_BUILD) -j

$(CALL_BIN): $(CALL_SRC) call/whip.h call/media.h call/note.h http.h $(LDC_LIBS)
	$(CC) $(CALL_CFLAGS) -c -o call/main.o call/main.c
	$(CC) $(CALL_CFLAGS) -c -o call/whip.o call/whip.c
	$(CC) $(CALL_CFLAGS) -c -o call/media.o call/media.c
	$(CC) $(CALL_CFLAGS) -c -o call/note.o call/note.c
	$(CXX) -o $@ call/main.o call/whip.o call/media.o call/note.o http.o $(LDC_LIBS) \
	  -static-libstdc++ -static-libgcc -lssl -lcrypto -lpthread -lm

# The helper rides along WHEN IT HAS BEEN BUILT, and is not a
# prerequisite: `make install` must keep working on a machine without
# cmake or a C++ compiler, which is the whole reason `call` is opt-in.
# It goes in the SAME directory because that is the first place
# call_helper_path looks — they are built and installed together.
install: $(BIN)
	install -d "$(DESTDIR)$(BINDIR)"
	install -m 0755 "$(BIN)" "$(DESTDIR)$(BINDIR)/$(BIN)"
	@if [ -x "$(CALL_BIN)" ]; then \
		install -m 0755 "$(CALL_BIN)" "$(DESTDIR)$(BINDIR)/$(CALL_BIN)"; \
		echo "installed $(CALL_BIN) beside $(BIN)"; \
	else \
		echo "no $(CALL_BIN) built — calls will open a browser (build it with 'make call')"; \
	fi

# The helper's objects and binary go too, but NOT vendor/build: rebuilding
# libdatachannel from scratch is minutes, it is not what `clean` is for,
# and it is already untracked. `rm -rf vendor/build` is the deliberate act.
clean:
	rm -f $(BIN) $(OBJS) $(OBJS:.o=.d) $(TESTS) $(CALL_BIN) call/main.o call/whip.o call/media.o call/note.o
