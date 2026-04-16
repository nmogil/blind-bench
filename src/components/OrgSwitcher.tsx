import { useQuery } from "convex/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronsUpDown } from "lucide-react";

export function OrgSwitcher() {
  const { org } = useOrg();
  const orgs = useQuery(api.organizations.listMyOrgs);
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent"
        aria-label={`Current organization: ${org.name}. Switch organization`}
      >
        {org.name}
        <ChevronsUpDown
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {orgs?.map(({ org: o }) => (
          <DropdownMenuItem
            key={o._id}
            onClick={() => navigate(`/orgs/${o.slug}`)}
            className={o._id === org._id ? "bg-accent" : ""}
          >
            {o.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
