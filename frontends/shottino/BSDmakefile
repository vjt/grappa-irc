# The BSDs' make (bmake) reads this file before Makefile, which is written
# in GNU make's dialect. Every target is handed to gmake unchanged, so
# `./configure && make && make install` reads the same on FreeBSD as on
# Linux (#2587). ./configure checks that gmake is installed.
#
# MAKEFLAGS is dropped from gmake's environment: bmake puts its own flags
# there in its own syntax, which gmake would misread. Variables given on the
# command line (`make install DESTDIR=/tmp/x`) are passed on explicitly.
GMAKE ?= gmake

.MAIN: all
FORWARD = env -u MAKEFLAGS -u MAKELEVEL ${GMAKE} ${.MAKEOVERRIDES:@v@${v}=${${v}:Q}@}

# Every requested target is PHONY and gets the forwarding rule explicitly.
# A `.DEFAULT:` rule is not enough: bmake applies it only to a target that
# does not exist, so `make call` — beside the call/ DIRECTORY — answered
# "`call' is up to date" and built nothing.
.PHONY: all ${.TARGETS:Nall}
all ${.TARGETS:Nall}:
	@${FORWARD} ${.TARGET}
