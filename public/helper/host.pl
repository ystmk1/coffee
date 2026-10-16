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
