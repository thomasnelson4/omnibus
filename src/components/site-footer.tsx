import Link from "next/link"
import { Github } from "lucide-react"
import packageJson from "../../package.json" // <-- Added import

// Data credits on every page (2026-10-14). Metron's data is licensed CC BY-SA 4.0, which asks for a
// credit, links to the source and the license, and a note that the data may have been changed - one
// line in a footer is enough. ComicVine's API terms ask apps to link back to it on any page that uses
// its data. Cover images belong to their publishers: neither data license covers them.
const creditLink = "underline underline-offset-2 hover:text-primary transition-colors"

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background transition-colors duration-300 py-6 md:py-3">
      <div className="container mx-auto flex flex-col items-center justify-between gap-4 md:min-h-16 md:flex-row px-6">
        <div className="text-center md:text-left">
          <p className="text-sm leading-loose text-muted-foreground">
            Developed by <span className="font-bold text-primary">hanks_cafe</span>.
          </p>
          <p data-testid="data-credits" className="text-xs leading-relaxed text-muted-foreground">
            Comic data from{" "}
            <a href="https://comicvine.gamespot.com/" target="_blank" rel="noreferrer" className={creditLink}>ComicVine</a>
            {" "}and{" "}
            <a href="https://metron.cloud/" target="_blank" rel="noreferrer" className={creditLink}>Metron</a>
            {" "}(Metron data licensed under{" "}
            <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" className={creditLink}>CC BY-SA 4.0</a>
            ; it may be edited in Omnibus). Covers belong to their publishers.
          </p>
        </div>

        <div className="flex items-center gap-6">
            <Link
                href="https://github.com/hankscafe/omnibus/"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
            >
                <Github className="h-4 w-4" />
                GitHub
            </Link>

            <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                {/* Dynamically pulling version from package.json */}
                v{packageJson.version}
            </div>
        </div>
      </div>
    </footer>
  )
}
