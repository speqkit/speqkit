# The tap formula, rendered by scripts/render-formula.mjs at release time and
# copied into speqkit/homebrew-tap as Formula/speqkit.rb.
#
# The formula is `speqkit` and the binary is `speq`: you install the project
# and you type the command, the same split as @angular/cli installing ng.
#
# No `depends_on "node"`. The archive already contains the runtime — that is
# the whole reason this exists, and a Homebrew dependency on Node would put
# back exactly the thing a Go team came here to avoid.
class Speqkit < Formula
  desc "Test framework that is mostly plugins"
  homepage "https://github.com/speqkit/speqkit"
  version "__VERSION__"
  license "MIT"

  on_macos do
    on_arm do
      url "__URL_DARWIN_ARM64__"
      sha256 "__SHA_DARWIN_ARM64__"
    end
    on_intel do
      url "__URL_DARWIN_X64__"
      sha256 "__SHA_DARWIN_X64__"
    end
  end

  on_linux do
    on_arm do
      url "__URL_LINUX_ARM64__"
      sha256 "__SHA_LINUX_ARM64__"
    end
    on_intel do
      url "__URL_LINUX_X64__"
      sha256 "__SHA_LINUX_X64__"
    end
  end

  def install
    bin.install "speq"
  end

  test do
    assert_match "speq #{version}", shell_output("#{bin}/speq version")
    system bin/"speq", "init"
    assert_predicate testpath/".speq/speq.yaml", :exist?
  end
end
