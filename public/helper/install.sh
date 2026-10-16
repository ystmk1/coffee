#!/bin/bash
# fetch helper setup for macOS. Run from the fetch helper page:
#   curl -fsSL https://coffee.ystmk1.workers.dev/helper/install.sh | bash
# What it does: writes server.pl and host.pl into ~/Library/Application Support/FetchHelper, registers the
# native messaging host com.fetch.helper for Chrome, Edge, Brave and Chromium (current user only), and
# starts the local server on localhost:47321. Nothing else is installed or changed.
set -e
DIR="$HOME/Library/Application Support/FetchHelper"
mkdir -p "$DIR"
/usr/bin/pkill -f "FetchHelper/server.pl" 2>/dev/null || true
cat > "$DIR/server.pl" <<'FETCH_EOF'
#!/usr/bin/perl
# fetch helper for macOS: the same tiny localhost server as the Windows one (server.ps1), written in
# Perl because macOS ships it (no Python/PowerShell needed). Core modules only.
#   POST /push   {folder,name,path}   only from the fetch extension; path must be an image inside ~/Downloads
#   POST /push   {folder,name,data}   same, with PNG bytes (base64), e.g. a video frame; kept in ./cache for a day
#   GET  /items?after=N               new items for the Figma plugin
#   GET  /file?id=N                   image bytes of a pushed item
#   GET  /ping, POST /quit
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use JSON::PP;
use MIME::Base64 qw(decode_base64);
use File::Basename qw(dirname);
use File::Path qw(make_path);
use Cwd qw(abs_path);

my $PORT = 47321;
my $VERSION = '1.2.0';
# The unpacked (developer) copy and the Chrome Web Store copy have different IDs; build-store.mjs adds the store one.
my @EXT_ORIGINS = ('chrome-extension://hkhnbfjdbacffnoomhaoclfcjnpdjgla');
my $IDLE_EXIT = 6 * 3600;

my $listen = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $PORT, Listen => 16, ReuseAddr => 1, Proto => 'tcp')
  or exit 0;    # already running

my $dir = dirname(abs_path($0));
my $cache = "$dir/cache";
make_path($cache);
for my $f (glob("$cache/*")) { unlink $f if -f $f && -M $f > 1 }

my $downloads = abs_path("$ENV{HOME}/Downloads") || "$ENV{HOME}/Downloads";
$downloads =~ s{/*$}{/};
my %MIME = ('.png' => 'image/png', '.jpg' => 'image/jpeg', '.jpeg' => 'image/jpeg', '.gif' => 'image/gif');
my @items;
my $next_id = 1;
my $last_seen = time;
my $json = JSON::PP->new->utf8->canonical;

sub respond {
  my ($c, $code, $type, $body, $origin) = @_;
  my %reason = (200 => 'OK', 204 => 'No Content', 400 => 'Bad Request', 403 => 'Forbidden', 404 => 'Not Found');
  $body = '' unless defined $body;
  my $h = "HTTP/1.1 $code $reason{$code}\r\nContent-Type: $type\r\nContent-Length: " . length($body) . "\r\nConnection: close\r\nCache-Control: no-store\r\n";
  $h .= "Access-Control-Allow-Origin: $origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type, x-fetch\r\nAccess-Control-Allow-Private-Network: true\r\n" if $origin;
  print {$c} $h . "\r\n" . $body;
}
sub respond_json { my ($c, $code, $obj, $origin) = @_; respond($c, $code, 'application/json', $json->encode($obj), $origin) }

sub read_request {
  my ($c) = @_;
  my $buf = '';
  my $sel = IO::Select->new($c);
  while ($buf !~ /\r\n\r\n/) {
    return undef unless $sel->can_read(5);
    my $n = sysread($c, $buf, 65536, length $buf);
    return undef unless $n;
    return undef if length($buf) > 1024 * 1024 && $buf !~ /\r\n\r\n/;
  }
  my ($head, $rest) = split /\r\n\r\n/, $buf, 2;
  my @lines = split /\r\n/, $head;
  my ($method, $target) = split / /, shift @lines;
  my %h;
  for (@lines) { $h{lc $1} = $2 if /^([^:]+):\s*(.*)$/ }
  my $len = $h{'content-length'} || 0;
  return undef if $len > 48 * 1024 * 1024;
  while (length($rest) < $len) {
    return undef unless $sel->can_read(15);
    my $n = sysread($c, $rest, 1024 * 1024, length $rest);
    last unless $n;
  }
  return { method => $method, target => $target, headers => \%h, body => $rest };
}

sub add_item {
  my ($folder, $name, $path, $type) = @_;
  my $it = { id => $next_id++, folder => $folder, name => $name, path => $path, type => $type, t => int(time * 1000) };
  push @items, $it;
  shift @items while @items > 500;
  return $it;
}

my $sel = IO::Select->new($listen);
while (1) {
  unless ($sel->can_read(30)) {
    last if time - $last_seen > $IDLE_EXIT;
    next;
  }
  my $c = $listen->accept or next;
  binmode $c;
  $c->autoflush(1);
  my $quit = 0;
  eval {
    my $req = read_request($c) or die "bad request\n";
    $last_seen = time;
    my $origin = $req->{headers}{origin} || '';
    my $from_ext = grep { $_ eq $origin } @EXT_ORIGINS;
    # Figma plugin UIs run with an opaque ("null") origin.
    my $from_plugin = $origin eq 'null' || $origin =~ m{^https://([a-z0-9-]+\.)*figma\.com$};
    my $cors = ($from_ext || $from_plugin) ? $origin : undef;
    my ($path, $query) = split /\?/, $req->{target}, 2;
    my %q;
    for (split /&/, $query || '') { my ($k, $v) = split /=/, $_, 2; $q{$k} = $v }

    if ($req->{method} eq 'OPTIONS') { respond($c, 204, 'text/plain', '', $cors) }
    elsif ($path eq '/ping') { respond_json($c, 200, { ok => JSON::PP::true, version => $VERSION, items => scalar @items }, $cors) }
    elsif ($path eq '/push') {
      if ($req->{method} ne 'POST' || !$from_ext || ($req->{headers}{'x-fetch'} || '') ne '1') { respond($c, 403, 'text/plain', '', undef) }
      else {
        my $m = $json->decode($req->{body});
        if ($m->{data}) {
          my $bytes = decode_base64($m->{data});
          if (length($bytes) < 8 || substr($bytes, 0, 4) ne "\x89PNG") { respond_json($c, 400, { ok => JSON::PP::false, error => 'not a PNG' }, $cors) }
          else {
            my $file = sprintf('%s/%d-%d.png', $cache, time, $next_id);
            open my $fh, '>:raw', $file or die "cache: $!\n";
            print {$fh} $bytes;
            close $fh;
            my $it = add_item($m->{folder}, $m->{name}, $file, 'image/png');
            respond_json($c, 200, { ok => JSON::PP::true, id => $it->{id} }, $cors);
          }
        } else {
          my $full = abs_path($m->{path} || '') || '';
          my ($ext) = lc($full) =~ /(\.[a-z0-9]+)$/;
          if (index(lc $full, lc $downloads) != 0 || !$ext || !$MIME{$ext} || !-f $full) {
            respond_json($c, 400, { ok => JSON::PP::false, error => 'not an image inside Downloads' }, $cors);
          } else {
            my $it = add_item($m->{folder}, $m->{name}, $full, $MIME{$ext});
            respond_json($c, 200, { ok => JSON::PP::true, id => $it->{id} }, $cors);
          }
        }
      }
    }
    elsif ($path eq '/items') {
      if (!$from_plugin && !$from_ext) { respond($c, 403, 'text/plain', '', undef) }
      else {
        my $after = $q{after} || 0;
        my @list = map { { id => $_->{id}, folder => $_->{folder}, name => $_->{name}, t => $_->{t} } } grep { $_->{id} > $after } @items;
        respond_json($c, 200, { latest => $next_id - 1, items => \@list }, $cors);
      }
    }
    elsif ($path eq '/file') {
      if (!$from_plugin && !$from_ext) { respond($c, 403, 'text/plain', '', undef) }
      else {
        my ($it) = grep { $_->{id} == ($q{id} || 0) } @items;
        if (!$it || !-f $it->{path}) { respond($c, 404, 'text/plain', '', $cors) }
        else {
          open my $fh, '<:raw', $it->{path} or die "read: $!\n";
          local $/;
          my $bytes = <$fh>;
          close $fh;
          respond($c, 200, $it->{type}, $bytes, $cors);
        }
      }
    }
    elsif ($path eq '/quit') {
      if (!$from_ext) { respond($c, 403, 'text/plain', '', undef) }
      else { respond_json($c, 200, { ok => JSON::PP::true }, $cors); $quit = 1 }
    }
    else { respond($c, 404, 'text/plain', '', $cors) }
    1;
  } or do { eval { respond($c, 400, 'text/plain', "$@", undef) } };
  close $c;
  last if $quit;
}
close $listen;
FETCH_EOF
cat > "$DIR/host.pl" <<'FETCH_EOF'
#!/usr/bin/perl
# fetch helper launcher for macOS (Chrome native messaging host). Chrome starts this on demand; it
# makes sure the local server (server.pl) is running, then exits. One request per launch:
# 4-byte length (native byte order, little-endian on Intel and Apple Silicon) + UTF-8 JSON, both ways.
use strict;
use warnings;
use IO::Socket::INET;
use JSON::PP;
use File::Basename qw(dirname);
use Cwd qw(abs_path);

my $VERSION = '1.2.0';
my $PORT = 47321;
my $dir = dirname(abs_path($0));
binmode STDIN;
binmode STDOUT;

sub send_msg {
  my $j = JSON::PP->new->utf8->encode($_[0]);
  print STDOUT pack('V', length $j) . $j;
  STDOUT->flush;
}
sub server_up {
  my $s = IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => $PORT, Proto => 'tcp', Timeout => 0.4);
  return 0 unless $s;
  close $s;
  return 1;
}

my $n = read(STDIN, my $len, 4);
exit 0 unless $n && $n == 4;
read(STDIN, my $body, unpack('V', $len));
my $msg = eval { JSON::PP->new->utf8->decode($body) } || {};
my $action = $msg->{action} || '';

if ($action eq 'ping') {
  send_msg({ ok => JSON::PP::true, version => $VERSION, running => server_up() ? JSON::PP::true : JSON::PP::false });
} elsif ($action eq 'ensure') {
  my $started = 0;
  unless (server_up()) {
    system(qq{/usr/bin/nohup /usr/bin/perl "$dir/server.pl" >/dev/null 2>&1 &});
    $started = 1;
    for (1 .. 30) { last if server_up(); select(undef, undef, undef, 0.1) }
  }
  send_msg({ ok => server_up() ? JSON::PP::true : JSON::PP::false, started => $started ? JSON::PP::true : JSON::PP::false, version => $VERSION });
} elsif ($action eq 'uninstall') {
  my $support = "$ENV{HOME}/Library/Application Support";
  unlink "$support/$_/NativeMessagingHosts/com.fetch.helper.json" for ('Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium');
  send_msg({ ok => JSON::PP::true });
  # Stop the server and remove our folder once this process has exited.
  system(qq{(sleep 2; /usr/bin/pkill -f "FetchHelper/server.pl"; rm -rf "$dir") >/dev/null 2>&1 &});
} else {
  send_msg({ ok => JSON::PP::false, error => "unknown action: $action" });
}
FETCH_EOF
chmod +x "$DIR/host.pl" "$DIR/server.pl"
MANIFEST='{"name":"com.fetch.helper","description":"fetch helper","path":"'"$DIR/host.pl"'","type":"stdio","allowed_origins":["chrome-extension://hkhnbfjdbacffnoomhaoclfcjnpdjgla/"]}'
for B in "Google/Chrome" "Microsoft Edge" "BraveSoftware/Brave-Browser" "Chromium"; do
  D="$HOME/Library/Application Support/$B/NativeMessagingHosts"
  mkdir -p "$D"
  printf '%s' "$MANIFEST" > "$D/com.fetch.helper.json"
done
/usr/bin/nohup /usr/bin/perl "$DIR/server.pl" >/dev/null 2>&1 &
echo
echo "  fetch helper installed. Go back to Chrome; you can close this window."
