import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { isFavorite, toggleFavorite } from "../lib/recents";
import { iconBtn } from "./ui";

export function StarBtn({ repo, page, title }: { repo: string; page: string; title: string }) {
  const [fav, setFav] = useState(false);
  useEffect(() => setFav(isFavorite(repo, page)), [repo, page]);
  return (
    <button
      onClick={() => setFav(toggleFavorite(repo, page, title))}
      title={fav ? "取消收藏" : "收藏"}
      className={iconBtn + (fav ? " text-amber-500" : "")}
    >
      <Star className={`size-4 ${fav ? "fill-amber-400" : ""}`} />
    </button>
  );
}
