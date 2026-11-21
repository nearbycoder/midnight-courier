#include "McHud.h"

#include "CanvasItem.h"
#include "Camera/CameraComponent.h"
#include "Engine/Canvas.h"
#include "Engine/Font.h"
#include "Fonts/CompositeFont.h"
#include "Fonts/FontMeasure.h"
#include "Framework/Application/SlateApplication.h"
#include "McBike.h"
#include "McGame.h"
#include "McWorld.h"
#include "McSettings.h"
#include "Misc/Paths.h"
#include "Rendering/SlateRenderer.h"

namespace
{
	const TCHAR* GFaceFiles[] = {
		TEXT("Anton-Regular.ttf"), TEXT("BarlowCondensed-Bold.ttf"), TEXT("BarlowCondensed-SemiBold.ttf"),
		TEXT("BarlowCondensed-Medium.ttf"), TEXT("BarlowCondensed-BoldItalic.ttf"), TEXT("BarlowCondensed-ExtraBoldItalic.ttf"),
	};
	const TCHAR* GFaceNames[] = { TEXT("Display"), TEXT("Bold"), TEXT("Semi"), TEXT("Medium"), TEXT("Italic"), TEXT("HeavyItalic") };

	UFont* GetFont()
	{
		// The canvas only draws text from a UFont object, so the TTFs are wrapped in one runtime font.
		static TWeakObjectPtr<UFont> Cached;
		if (!Cached.IsValid())
		{
			UFont* NewFont = NewObject<UFont>(GetTransientPackage(), TEXT("McHudFont"));
			NewFont->FontCacheType = EFontCacheType::Runtime;
			FCompositeFont& Composite = NewFont->GetMutableInternalCompositeFont();
			for (int32 i = 0; i < UE_ARRAY_COUNT(GFaceFiles); ++i)
			{
				const FString Path = FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir() / TEXT("Courier/Fonts") / GFaceFiles[i]);
				Composite.DefaultTypeface.Fonts.Add(FTypefaceEntry(FName(GFaceNames[i]), Path, EFontHinting::Default, EFontLoadingPolicy::LazyLoad));
			}
			NewFont->AddToRoot();
			Cached = NewFont;
		}
		return Cached.Get();
	}

	FSlateFontInfo FontInfo(EMcFace Face, float Size, float Spacing)
	{
		FSlateFontInfo Info(GetFont(), FMath::Max(1, FMath::RoundToInt(Size)), FName(GFaceNames[(int32)Face]));
		Info.LetterSpacing = FMath::RoundToInt(Spacing);
		return Info;
	}

	const FLinearColor Ink(0.93f, 0.95f, 1.f);
	const FLinearColor Dim(0.6f, 0.66f, 0.76f);
	const FLinearColor Amber(1.f, 0.7f, 0.22f);
	const FLinearColor Teal(0.3f, 0.95f, 0.85f);
	const FLinearColor Red(1.f, 0.28f, 0.22f);
	const FLinearColor Panel(0.015f, 0.02f, 0.035f, 0.72f);
	const FLinearColor Magenta(1.f, 0.25f, 0.6f);

	FLinearColor WithA(FLinearColor C, float A) { C.A *= A; return C; }
}

FVector2D AMcHud::Measure(const FString& Str, EMcFace Face, float Size, float Spacing)
{
	const FSlateFontInfo Info = FontInfo(Face, Size * S, Spacing * S);
	if (FSlateApplication::IsInitialized() && FSlateApplication::Get().GetRenderer())
	{
		const FVector2f M = FSlateApplication::Get().GetRenderer()->GetFontMeasureService()->Measure(Str, Info);
		return FVector2D(M.X, M.Y);
	}
	return FVector2D(Str.Len() * Size * S * 0.5f, Size * S * 1.2f);
}

float AMcHud::Text(const FString& Str, float X, float Y, EMcFace Face, float Size, const FLinearColor& C, EMcAlign Align, float Shadow, float Spacing)
{
	if (Str.IsEmpty() || C.A <= 0.001f) { return 0.f; }
	const FSlateFontInfo Info = FontInfo(Face, Size * S, Spacing * S);
	const float Width = Measure(Str, Face, Size, Spacing).X;
	const float Left = FMath::RoundToFloat(Align == EMcAlign::Center ? X - Width * 0.5f : (Align == EMcAlign::Right ? X - Width : X));
	const float Top = FMath::RoundToFloat(Y);
	if (Shadow > 0.f)
	{
		FCanvasTextItem Under(FVector2D(Left + Shadow * S, Top + Shadow * S), FText::FromString(Str), Info, FLinearColor(0, 0, 0, 0.6f * C.A));
		Under.BlendMode = SE_BLEND_Translucent;
		Canvas->DrawItem(Under);
	}
	FCanvasTextItem Item(FVector2D(Left, Top), FText::FromString(Str), Info, C);
	Item.BlendMode = SE_BLEND_Translucent;
	Canvas->DrawItem(Item);
	return Width;
}

void AMcHud::Rect(float X, float Y, float Wd, float Ht, const FLinearColor& C)
{
	if (C.A <= 0.001f) { return; }
	FCanvasTileItem Tile(FVector2D(X, Y), FVector2D(Wd, Ht), C);
	Tile.BlendMode = SE_BLEND_Translucent;
	Canvas->DrawItem(Tile);
}

void AMcHud::Line(float X0, float Y0, float X1, float Y1, const FLinearColor& C, float Thick)
{
	FCanvasLineItem L(FVector2D(X0, Y0), FVector2D(X1, Y1));
	L.SetColor(C);
	L.LineThickness = Thick;
	L.BlendMode = SE_BLEND_Translucent;
	Canvas->DrawItem(L);
}

FString AMcHud::FormatTime(float T, bool bTenths) const
{
	T = FMath::Max(0.f, T);
	const int32 M = FMath::FloorToInt(T / 60.f);
	const float Sec = T - M * 60.f;
	if (bTenths)
	{
		const int32 Whole = FMath::FloorToInt(Sec);
		const int32 Hundredths = FMath::FloorToInt((Sec - Whole) * 100.f);
		return FString::Printf(TEXT("%d:%02d.%02d"), M, Whole, Hundredths);
	}
	return FString::Printf(TEXT("%d:%02d"), M, FMath::FloorToInt(Sec));
}

void AMcHud::DrawHUD()
{
	Super::DrawHUD();
	AMcGameMode* G = GetWorld() ? Cast<AMcGameMode>(GetWorld()->GetAuthGameMode()) : nullptr;
	if (!G || !Canvas || FParse::Param(FCommandLine::Get(), TEXT("McNoHud"))) { return; }
	W = Canvas->ClipX; H = Canvas->ClipY;
	S = H / 1080.f;
	Clock += GetWorld()->GetDeltaSeconds();

	switch (G->Phase)
	{
	case EMcPhase::Title: DrawTitle(G); break;
	case EMcPhase::Countdown:
	case EMcPhase::Riding:
	case EMcPhase::Respawning: DrawRiding(G); break;
	case EMcPhase::Delivered:
	case EMcPhase::Failed: DrawResults(G); break;
	}
	if (G->bPaused && !G->bSettingsOpen) { DrawPause(G); }
	if (G->bSettingsOpen) { DrawSettings(G); }
	if (FMcSettings::Get().bShowFps)
	{
		Text(FString::Printf(TEXT("%d FPS  ·  %.1f ms"), FMath::RoundToInt(G->MeasuredFps), 1000.f / FMath::Max(G->MeasuredFps, 1.f)), W - 20 * S, H - 26 * S, EMcFace::Semi, 15, Dim, EMcAlign::Right, 1.f, 1.f);
	}
	if (G->Fade > 0.001f) { Rect(0, 0, W, H, FLinearColor(0, 0, 0, G->Fade)); }
}

// ======================================================================================================
// While riding
// ======================================================================================================
void AMcHud::DrawRiding(AMcGameMode* G)
{
	AMcBike* B = G->GetBike();
	const float Remaining = G->TimeLimit - G->RunTime;

	// Damage vignette.
	if (G->DamageFlash > 0.01f)
	{
		const float A = G->DamageFlash * 0.35f;
		Rect(0, 0, W, 40 * S, WithA(Red, A));
		Rect(0, H - 40 * S, W, 40 * S, WithA(Red, A));
		Rect(0, 0, 40 * S, H, WithA(Red, A * 0.7f));
		Rect(W - 40 * S, 0, 40 * S, H, WithA(Red, A * 0.7f));
	}

	// ---- clock --------------------------------------------------------------------------------------
	{
		const bool bLow = Remaining < 15.f;
		const float Pulse = bLow ? 0.75f + 0.25f * FMath::Sin(Clock * 10.f) : 1.f;
		const FLinearColor C = bLow ? WithA(Red, Pulse) : Ink;
		Text(TEXT("TIME LEFT"), W * 0.5f, 26 * S, EMcFace::Semi, 17, Dim, EMcAlign::Center, 1.f, 4.f);
		Text(FormatTime(Remaining), W * 0.5f, 42 * S, EMcFace::Display, 58, C, EMcAlign::Center, 3.f, 1.f);

		// Split against the best run.
		if (G->LastSplitAge < 3.5f && G->BestSplits.Num() > 0)
		{
			const float A = FMath::Clamp((3.5f - G->LastSplitAge) / 0.5f, 0.f, 1.f);
			const float D = G->LastSplitDelta;
			const FString DS = FString::Printf(TEXT("%s%.2f"), D <= 0.f ? TEXT("-") : TEXT("+"), FMath::Abs(D));
			Text(DS, W * 0.5f, 118 * S, EMcFace::HeavyItalic, 34, WithA(D <= 0.f ? Teal : Red, A), EMcAlign::Center);
			Text(G->LastSplitName.ToUpper(), W * 0.5f, 156 * S, EMcFace::Semi, 16, WithA(Dim, A), EMcAlign::Center, 1.f, 3.f);
		}
		else if (G->LastSplitAge < 2.5f)
		{
			const float A = FMath::Clamp((2.5f - G->LastSplitAge) / 0.5f, 0.f, 1.f);
			Text(G->LastSplitName.ToUpper(), W * 0.5f, 122 * S, EMcFace::Bold, 22, WithA(Teal, A), EMcAlign::Center, 1.f, 3.f);
		}
	}

	// ---- drop-off compass -------------------------------------------------------------------------------
	if (G->Phase != EMcPhase::Countdown)
	{
		const float Cx = W * 0.5f, Cy = 190 * S;
		const float Ang = FMath::DegreesToRadians(G->GoalBearing);
		const FVector2D Dir(FMath::Sin(Ang), -FMath::Cos(Ang));
		const FVector2D Perp(-Dir.Y, Dir.X);
		const FVector2D Tip = FVector2D(Cx, Cy) + Dir * 16 * S;
		const FVector2D L = FVector2D(Cx, Cy) - Dir * 10 * S + Perp * 11 * S;
		const FVector2D R = FVector2D(Cx, Cy) - Dir * 10 * S - Perp * 11 * S;
		Line(Tip.X, Tip.Y, L.X, L.Y, Amber, 3.f * S);
		Line(Tip.X, Tip.Y, R.X, R.Y, Amber, 3.f * S);
		Text(FString::Printf(TEXT("%d m"), FMath::RoundToInt(G->DistanceToGoal)), Cx, Cy + 18 * S, EMcFace::Semi, 18, Amber, EMcAlign::Center, 1.f, 2.f);
	}

	// ---- best run, top right --------------------------------------------------------------------------
	if (G->bHasBest)
	{
		Text(TEXT("BEST TIP"), W - 40 * S, 30 * S, EMcFace::Semi, 16, Dim, EMcAlign::Right, 1.f, 3.f);
		Text(FString::Printf(TEXT("$%.2f  %s"), G->Best.Tip, *G->Best.Grade), W - 40 * S, 48 * S, EMcFace::Bold, 30, Ink, EMcAlign::Right);
		Text(FString::Printf(TEXT("%s  ·  %d%%"), *FormatTime(G->Best.Time), FMath::RoundToInt(G->Best.Condition)), W - 40 * S, 84 * S, EMcFace::Medium, 18, Dim, EMcAlign::Right);
		if (G->IsGhostVisible()) { Text(TEXT("GHOST  [G]"), W - 40 * S, 108 * S, EMcFace::Semi, 15, WithA(Teal, 0.8f), EMcAlign::Right, 1.f, 2.f); }
	}

	// ---- speed, bottom left -----------------------------------------------------------------------------
	{
		const float Kmh = B->GetSpeed() * 3.6f;
		const float X = 50 * S, Y = H - 150 * S;
		Text(FString::Printf(TEXT("%d"), FMath::RoundToInt(Kmh)), X, Y, EMcFace::Display, 72, Ink, EMcAlign::Left, 3.f);
		const float Wd = Measure(FString::Printf(TEXT("%d"), FMath::RoundToInt(Kmh)), EMcFace::Display, 72).X;
		Text(TEXT("KM/H"), X + Wd + 10 * S, Y + 52 * S, EMcFace::Semi, 18, Dim, EMcAlign::Left, 1.f, 3.f);
		// State chips.
		float CX = X;
		auto Chip = [&](const FString& L, const FLinearColor& C)
		{
			const float Tw = Measure(L, EMcFace::Bold, 15, 2.f).X;
			Rect(CX, Y + 98 * S, Tw + 16 * S, 24 * S, WithA(C, 0.18f));
			Text(L, CX + 8 * S, Y + 100 * S, EMcFace::Bold, 15, C, EMcAlign::Left, 0.f, 2.f);
			CX += Tw + 24 * S;
		};
		if (B->IsBraced()) { Chip(TEXT("BRACED"), Teal); }
		if (B->IsDrifting()) { Chip(TEXT("SLIDE"), Amber); }
		if (!B->IsGrounded() && B->GetAirTime() > 0.25f) { Chip(FString::Printf(TEXT("AIR %.1fs"), B->GetAirTime()), Ink); }
	}

	DrawPackage(G, W - 50 * S, H - 50 * S);
	if (G->GetCourierWorld()->MapLines.Num() > 0) { DrawMinimap(G, 50 * S + 110 * S, H - 330 * S, 220 * S); }

	// ---- callouts ----------------------------------------------------------------------------------------
	{
		float Y = H * 0.30f;
		for (const FMcCallout& C : G->Callouts)
		{
			const float In = FMath::Clamp(C.Age / 0.12f, 0.f, 1.f);
			const float Out = FMath::Clamp((C.Life - C.Age) / 0.35f, 0.f, 1.f);
			const float A = In * Out;
			const float Pop = 1.f + (1.f - In) * 0.25f;
			Text(C.Text, W * 0.5f, Y, EMcFace::HeavyItalic, 40 * C.Size * Pop, WithA(C.Color, A), EMcAlign::Center, 3.f, 2.f);
			Y += 44 * S * C.Size;
			if (!C.Sub.IsEmpty())
			{
				Text(C.Sub, W * 0.5f, Y, EMcFace::Semi, 20, WithA(Ink, A * 0.85f), EMcAlign::Center, 1.5f, 2.f);
				Y += 28 * S;
			}
			Y += 8 * S;
		}
	}

	if (!G->Prompt.IsEmpty())
	{
		const float A = 0.7f + 0.3f * FMath::Sin(Clock * 8.f);
		Text(G->Prompt, W * 0.5f, H * 0.62f, EMcFace::Bold, 30, WithA(Amber, A), EMcAlign::Center, 2.f, 4.f);
	}

	// ---- countdown --------------------------------------------------------------------------------------
	if (G->Phase == EMcPhase::Countdown)
	{
		const int32 Step = FMath::FloorToInt(G->PhaseTime / 0.5f);
		const float Local = FMath::Frac(G->PhaseTime / 0.5f);
		const FString L = Step == 0 ? TEXT("3") : Step == 1 ? TEXT("2") : TEXT("1");
		const float Sc = 1.3f - Local * 0.3f;
		Text(L, W * 0.5f, H * 0.36f, EMcFace::Display, 150 * Sc, WithA(Ink, 1.f - Local * 0.6f), EMcAlign::Center, 4.f);
		if (G->RunCount <= 1)
		{
			Text(TEXT("Deliver the package to the Hotel Marlowe. Don't break it."), W * 0.5f, H * 0.62f, EMcFace::Medium, 26, Ink, EMcAlign::Center, 2.f);
		}
	}
	else if (G->Phase == EMcPhase::Riding && G->PhaseTime < 0.7f && G->RunTime < 1.f)
	{
		const float A = 1.f - G->PhaseTime / 0.7f;
		Text(TEXT("GO"), W * 0.5f, H * 0.36f, EMcFace::Display, 150 * (1.f + (1.f - A) * 0.4f), WithA(Amber, A), EMcAlign::Center, 4.f);
	}

	// First-run control hints.
	if (FMcSettings::Get().bHints && G->RunCount <= 2 && G->RunTime < 14.f && G->Phase == EMcPhase::Riding)
	{
		const float A = FMath::Clamp((14.f - G->RunTime) / 1.5f, 0.f, 1.f) * 0.9f;
		const float Y = H - 96 * S;
		Text(TEXT("W pedal  ·  S brake  ·  A/D steer  ·  SHIFT slide"), W * 0.5f, Y, EMcFace::Medium, 20, WithA(Dim, A), EMcAlign::Center, 1.f, 1.f);
		Text(TEXT("hold SPACE to brace, release to hop  ·  R restart"), W * 0.5f, Y + 28 * S, EMcFace::Medium, 20, WithA(Dim, A), EMcAlign::Center, 1.f, 1.f);
	}
}

void AMcHud::DrawPackage(AMcGameMode* G, float Right, float Bottom)
{
	AMcBike* B = G->GetBike();
	const float Cond = B->GetCondition();
	ShownCondition = FMath::FInterpTo(ShownCondition, Cond, GetWorld()->GetDeltaSeconds(), 6.f);
	ShownG = FMath::Max(B->GetPackageG(), ShownG - GetWorld()->GetDeltaSeconds() * 3.f);
	const float Wd = 300 * S;
	const float X = Right - Wd, Y = Bottom - 150 * S;
	Rect(X - 16 * S, Y - 14 * S, Wd + 32 * S, 164 * S, Panel);

	const FLinearColor C = Cond > 75.f ? Teal : Cond > 40.f ? Amber : Red;
	Text(TEXT("PACKAGE"), X, Y, EMcFace::Semi, 16, Dim, EMcAlign::Left, 0.f, 3.f);
	Text(TEXT("FRAGILE · ANTIQUE GLASS"), X + Wd, Y, EMcFace::Semi, 14, WithA(Amber, 0.8f), EMcAlign::Right, 0.f, 2.f);
	Text(FString::Printf(TEXT("%d%%"), FMath::CeilToInt(ShownCondition)), X, Y + 22 * S, EMcFace::Display, 44, C, EMcAlign::Left, 2.f);

	// The box icon picks up cracks as it suffers.
	{
		const float Bx = X + Wd - 56 * S, By = Y + 28 * S, Bs = 50 * S;
		const float Jit = FMath::Clamp(ShownG - 1.5f, 0.f, 3.f) * 2.f * S;
		const float Jx = FMath::Sin(Clock * 71.f) * Jit, Jy = FMath::Sin(Clock * 59.f) * Jit;
		Rect(Bx + Jx, By + Jy, Bs, Bs, FLinearColor(0.55f, 0.38f, 0.2f, 0.95f));
		Rect(Bx + Jx, By + Jy + Bs * 0.42f, Bs, Bs * 0.16f, FLinearColor(0.75f, 0.62f, 0.38f, 0.95f));
		Text(TEXT("!"), Bx + Jx + Bs * 0.5f, By + Jy + 2 * S, EMcFace::Display, 30, FLinearColor(0.7f, 0.08f, 0.05f), EMcAlign::Center, 0.f);
		const float Damage = 1.f - Cond / 100.f;
		const int32 Cracks = FMath::FloorToInt(Damage * 7.f);
		FRandomStream R(1234);
		for (int32 i = 0; i < Cracks; ++i)
		{
			float Px = Bx + Jx + R.FRandRange(0.15f, 0.85f) * Bs, Py = By + Jy + R.FRandRange(0.1f, 0.9f) * Bs;
			for (int32 k = 0; k < 3; ++k)
			{
				const float Nx = Px + R.FRandRange(-0.25f, 0.25f) * Bs, Ny = Py + R.FRandRange(-0.25f, 0.25f) * Bs;
				Line(Px, Py, FMath::Clamp(Nx, Bx + Jx, Bx + Jx + Bs), FMath::Clamp(Ny, By + Jy, By + Jy + Bs), FLinearColor(0.05f, 0.02f, 0.01f, 0.9f), 2.f * S);
				Px = Nx; Py = Ny;
			}
		}
	}

	// Condition bar.
	const float BarY = Y + 98 * S;
	Rect(X, BarY, Wd, 8 * S, FLinearColor(1, 1, 1, 0.08f));
	Rect(X, BarY, Wd * ShownCondition / 100.f, 8 * S, C);
	if (Cond < ShownCondition - 0.5f) { Rect(X + Wd * Cond / 100.f, BarY, Wd * (ShownCondition - Cond) / 100.f, 8 * S, WithA(Red, 0.9f)); }

	// Live shock meter: how hard the box is being shaken right now.
	const float GBar = FMath::Clamp((ShownG - 1.f) / 4.f, 0.f, 1.f);
	const float GY = BarY + 22 * S;
	Text(TEXT("SHOCK"), X, GY - 3 * S, EMcFace::Semi, 13, Dim, EMcAlign::Left, 0.f, 2.f);
	const float Mx = X + 52 * S, Mw = Wd - 52 * S;
	const int32 Segs = 16;
	for (int32 i = 0; i < Segs; ++i)
	{
		const float F = (float)i / Segs;
		const bool bOn = F < GBar;
		const FLinearColor SC = F < 0.4f ? Teal : F < 0.7f ? Amber : Red;
		Rect(Mx + i * (Mw / Segs), GY, Mw / Segs - 3 * S, 10 * S, bOn ? SC : FLinearColor(1, 1, 1, 0.07f));
	}
}

void AMcHud::DrawMinimap(AMcGameMode* G, float Cx, float Cy, float Size)
{
	AMcWorld* Wd = G->GetCourierWorld();
	AMcBike* B = G->GetBike();
	const FVector P = B->GetWorldLocation();
	const float CamYaw = B->Camera->GetComponentRotation().Yaw;
	const float Range = 26000.f;        // cm shown across the map
	const float Scale = Size / Range;
	const float Ang = FMath::DegreesToRadians(-CamYaw - 90.f);
	const float Ca = FMath::Cos(Ang), Sa = FMath::Sin(Ang);
	auto ToMap = [&](const FVector2D& Q)
	{
		const float Dx = Q.X - P.X, Dy = Q.Y - P.Y;
		return FVector2D(Cx + (Dx * Ca - Dy * Sa) * Scale, Cy + (Dx * Sa + Dy * Ca) * Scale);
	};
	const float R = Size * 0.5f;
	Rect(Cx - R, Cy - R, Size, Size, FLinearColor(0.01f, 0.015f, 0.03f, 0.55f));
	auto Inside = [&](const FVector2D& Q) { return FMath::Abs(Q.X - Cx) < R && FMath::Abs(Q.Y - Cy) < R; };
	// Liang-Barsky clip of a segment to the map square (inset so thick strokes stay inside).
	auto Clip = [&](FVector2D& A, FVector2D& Bq, float Inset) -> bool
	{
		const float X0 = Cx - R + Inset, X1 = Cx + R - Inset, Y0 = Cy - R + Inset, Y1 = Cy + R - Inset;
		const FVector2D D = Bq - A;
		float T0 = 0.f, T1 = 1.f;
		const float P[4] = { -D.X, D.X, -D.Y, D.Y };
		const float Q[4] = { A.X - X0, X1 - A.X, A.Y - Y0, Y1 - A.Y };
		for (int32 k = 0; k < 4; ++k)
		{
			if (FMath::Abs(P[k]) < 1e-6f) { if (Q[k] < 0.f) { return false; } continue; }
			const float T = Q[k] / P[k];
			if (P[k] < 0.f) { T0 = FMath::Max(T0, T); } else { T1 = FMath::Min(T1, T); }
			if (T0 > T1) { return false; }
		}
		const FVector2D A0 = A;
		A = A0 + D * T0;
		Bq = A0 + D * T1;
		return true;
	};
	for (int32 i = 0; i < Wd->MapLines.Num(); ++i)
	{
		const TArray<FVector2D>& L = Wd->MapLines[i];
		const int32 Kind = Wd->MapLineKinds[i];
		const FLinearColor C = Kind == 0 ? FLinearColor(0.6f, 0.65f, 0.75f, 0.55f) : Kind == 3 ? FLinearColor(0.2f, 0.45f, 0.7f, 0.6f) : FLinearColor(1.f, 0.7f, 0.25f, 0.7f);
		const float T = (Kind == 0 ? 5.f : Kind == 3 ? 2.f : 3.f) * S;
		for (int32 k = 0; k + 1 < L.Num(); ++k)
		{
			FVector2D A = ToMap(L[k]), Bq = ToMap(L[k + 1]);
			if (!Clip(A, Bq, T * 0.5f + 1.f)) { continue; }
			Line(A.X, A.Y, Bq.X, Bq.Y, C, T);
		}
	}
	// Drop-off.
	{
		FVector2D Gm = ToMap(FVector2D(Wd->GoalPos.X, Wd->GoalPos.Y));
		const float Pulse = 5.f + 2.f * FMath::Sin(Clock * 5.f);
		Gm.X = FMath::Clamp(Gm.X, Cx - R + 9 * S, Cx + R - 9 * S);
		Gm.Y = FMath::Clamp(Gm.Y, Cy - R + 9 * S, Cy + R - 9 * S);
		Rect(Gm.X - Pulse * S, Gm.Y - Pulse * S, Pulse * 2 * S, Pulse * 2 * S, Amber);
	}
	// Ghost.
	if (G->IsGhostVisible())
	{
		const FVector Gp = G->GetGhost()->GetWorldLocation();
		const FVector2D Gm = ToMap(FVector2D(Gp.X, Gp.Y));
		if (Inside(Gm)) { Rect(Gm.X - 4 * S, Gm.Y - 4 * S, 8 * S, 8 * S, WithA(Teal, 0.8f)); }
	}
	// You (always pointing up).
	Line(Cx, Cy - 10 * S, Cx - 7 * S, Cy + 7 * S, Ink, 2.5f * S);
	Line(Cx, Cy - 10 * S, Cx + 7 * S, Cy + 7 * S, Ink, 2.5f * S);
	Line(Cx - 7 * S, Cy + 7 * S, Cx + 7 * S, Cy + 7 * S, Ink, 2.5f * S);
}

// ======================================================================================================
// Title
// ======================================================================================================
void AMcHud::DrawTitle(AMcGameMode* G)
{
	const float A = FMath::Clamp(G->PhaseTime / 1.2f, 0.f, 1.f);
	// Left-side gradient panel.
	// Gradient backdrop from abutting strips (exact integer edges, so no double-blended seams).
	const int32 Strips = 96;
	for (int32 i = 0; i < Strips; ++i)
	{
		const float X0 = FMath::FloorToFloat(W * 0.6f * i / Strips), X1 = FMath::FloorToFloat(W * 0.6f * (i + 1) / Strips);
		const float F = (i + 0.5f) / Strips;
		Rect(X0, 0, X1 - X0, H, FLinearColor(0.005f, 0.008f, 0.02f, 0.85f * FMath::Square(1.f - F) * A));
	}
	const float X = 110 * S;
	float Y = H * 0.2f;
	Y = H * 0.14f;
	Text(TEXT("MIDNIGHT"), X, Y, EMcFace::Display, 118, WithA(Ink, A), EMcAlign::Left, 4.f, 6.f);
	Y += 150 * S;
	Text(TEXT("COURIER"), X, Y, EMcFace::Display, 118, WithA(Amber, A), EMcAlign::Left, 4.f, 6.f);
	Y += 215 * S;
	Text(TEXT("One package. Ridiculously fragile."), X, Y, EMcFace::Medium, 30, WithA(Ink, A * 0.95f), EMcAlign::Left, 2.f);
	Y += 40 * S;
	Text(TEXT("Two minutes to get it down the hill."), X, Y, EMcFace::Medium, 30, WithA(Ink, A * 0.95f), EMcAlign::Left, 2.f);
	Y += 80 * S;

	const TCHAR* Items[] = { TEXT("RIDE"), TEXT("SETTINGS"), TEXT("QUIT") };
	for (int32 i = 0; i < 3; ++i)
	{
		const bool bSel = G->TitleIndex == i && !G->bSettingsOpen;
		const float Pulse = bSel ? 0.75f + 0.25f * FMath::Sin(Clock * 4.f) : 1.f;
		if (bSel) { Rect(X - 22 * S, Y + 8 * S, 8 * S, 28 * S, WithA(Amber, A * Pulse)); }
		Text(Items[i], X, Y, EMcFace::Bold, 36, WithA(bSel ? Amber : Dim, A * Pulse), EMcAlign::Left, 2.f, 5.f);
		Y += 50 * S;
	}
	Y += 30 * S;

	const TCHAR* Rows[][2] = {
		{ TEXT("W / RT"), TEXT("pedal") },
		{ TEXT("S / LT"), TEXT("brake") },
		{ TEXT("A D / stick"), TEXT("steer  ·  in the air, W S tilt the bike") },
		{ TEXT("SPACE / A"), TEXT("hold to brace for impact, release to hop") },
		{ TEXT("SHIFT / X"), TEXT("power slide") },
		{ TEXT("R / Y"), TEXT("instant restart") },
	};
	for (const auto& Row : Rows)
	{
		Text(Row[0], X, Y, EMcFace::Bold, 20, WithA(Amber, A * 0.9f), EMcAlign::Left, 1.f, 2.f);
		Text(Row[1], X + 150 * S, Y, EMcFace::Medium, 20, WithA(Dim, A), EMcAlign::Left, 1.f);
		Y += 28 * S;
	}

	if (G->bHasBest)
	{
		Y += 30 * S;
		Text(FString::Printf(TEXT("BEST TIP  $%.2f  ·  %s  ·  %s  ·  package %d%%"), G->Best.Tip, *G->Best.Grade, *FormatTime(G->Best.Time), FMath::RoundToInt(G->Best.Condition)),
			X, Y, EMcFace::Semi, 22, WithA(Ink, A), EMcAlign::Left, 1.f, 2.f);
	}
}

// ======================================================================================================
// Results
// ======================================================================================================
void AMcHud::DrawResults(AMcGameMode* G)
{
	const float T = G->PhaseTime;
	const float A = FMath::Clamp((T - 0.4f) / 0.5f, 0.f, 1.f);
	Rect(0, 0, W, H, FLinearColor(0.f, 0.f, 0.02f, 0.45f * A));
	const FMcRunResult& R = G->Result;
	const float Cx = W * 0.5f;
	float Y = H * 0.16f;
	if (G->Phase == EMcPhase::Failed)
	{
		const bool bBroken = G->Fail == EMcFail::Broken;
		Text(bBroken ? TEXT("PACKAGE DESTROYED") : TEXT("TOO LATE"), Cx, Y, EMcFace::Display, 96, WithA(Red, A), EMcAlign::Center, 4.f, 4.f);
		Y += 120 * S;
		Text(bBroken ? TEXT("The client hears it before they see it. No tip tonight.") : TEXT("The hotel's night manager has already gone home. No tip tonight."),
			Cx, Y, EMcFace::Medium, 28, WithA(Ink, A), EMcAlign::Center, 2.f);
		Y += 90 * S;
		Text(TEXT("PRESS R TO TRY AGAIN"), Cx, Y, EMcFace::Bold, 30, WithA(Teal, A * (0.6f + 0.4f * FMath::Sin(Clock * 3.f))), EMcAlign::Center, 2.f, 5.f);
		return;
	}

	Text(TEXT("DELIVERED"), Cx, Y, EMcFace::Display, 96, WithA(Amber, A), EMcAlign::Center, 4.f, 6.f);
	Y += 162 * S;
	const float Cond = R.Condition;
	const FString Verdict = Cond >= 98.f ? TEXT("\"Not a scratch. Are you even human?\"")
		: Cond >= 90.f ? TEXT("\"Perfect. Just perfect.\"")
		: Cond >= 75.f ? TEXT("\"Is that... a chip? Fine. It's fine.\"")
		: Cond >= 50.f ? TEXT("\"Why does it rattle when I shake it?\"")
		: Cond >= 25.f ? TEXT("\"This was my grandmother's.\"")
		: TEXT("\"Is this... glitter? It used to be a swan.\"");
	Text(Verdict, Cx, Y, EMcFace::Italic, 30, WithA(Ink, A), EMcAlign::Center, 2.f);
	Y += 70 * S;

	// Rows reveal one by one.
	struct FRow { FString L; FString V; FLinearColor C; };
	TArray<FRow> Rows;
	Rows.Add({ TEXT("TIME"), FormatTime(R.Time), Ink });
	Rows.Add({ TEXT("PACKAGE"), FString::Printf(TEXT("%d%%"), FMath::RoundToInt(R.Condition)), Cond > 75.f ? Teal : Cond > 40.f ? Amber : Red });
	Rows.Add({ TEXT("DELIVERY FEE + EARLY BONUS"), FString::Printf(TEXT("$%.2f"), 20.f + R.TimeBonus), Ink });
	Rows.Add({ TEXT("CARE MULTIPLIER"), FString::Printf(TEXT("x%.2f"), R.CareMultiplier), Ink });
	if (R.PristineBonus > 0.f) { Rows.Add({ R.PristineBonus >= 15.f ? TEXT("PRISTINE BONUS") : TEXT("CAREFUL BONUS"), FString::Printf(TEXT("+$%.2f"), R.PristineBonus), Teal }); }
	Rows.Add({ TEXT("LANDINGS  ·  FEATHERED"), FString::Printf(TEXT("%d  ·  %d"), R.Landings, R.PerfectLandings), Dim });
	if (R.Crashes > 0) { Rows.Add({ TEXT("WIPEOUTS"), FString::Printf(TEXT("%d"), R.Crashes), Red }); }
	const float RowW = 560 * S;
	for (int32 i = 0; i < Rows.Num(); ++i)
	{
		const float RA = FMath::Clamp((T - 0.8f - i * 0.18f) / 0.25f, 0.f, 1.f);
		Text(Rows[i].L, Cx - RowW * 0.5f, Y, EMcFace::Semi, 22, WithA(Dim, RA), EMcAlign::Left, 1.f, 2.f);
		Text(Rows[i].V, Cx + RowW * 0.5f, Y - 4 * S, EMcFace::Bold, 30, WithA(Rows[i].C, RA), EMcAlign::Right, 1.f);
		Y += 40 * S;
	}
	Y += 16 * S;
	const float TA = FMath::Clamp((T - 0.9f - Rows.Num() * 0.18f) / 0.3f, 0.f, 1.f);
	Rect(Cx - RowW * 0.5f, Y, RowW, 2 * S, WithA(Ink, TA * 0.4f));
	Y += 16 * S;
	const float Count = FMath::Clamp((T - 1.0f - Rows.Num() * 0.18f) / 0.8f, 0.f, 1.f);
	Text(TEXT("TIP"), Cx - RowW * 0.5f, Y + 18 * S, EMcFace::Bold, 30, WithA(Ink, TA), EMcAlign::Left, 1.f, 4.f);
	Text(FString::Printf(TEXT("$%.2f"), R.Tip * FMath::InterpEaseOut(0.f, 1.f, Count, 3.f)), Cx + RowW * 0.5f, Y, EMcFace::Display, 64, WithA(Amber, TA), EMcAlign::Right, 3.f);
	// Grade stamp.
	if (Count >= 1.f)
	{
		const float GA = FMath::Clamp((T - 2.0f - Rows.Num() * 0.18f) / 0.15f, 0.f, 1.f);
		const float Sc = 1.f + (1.f - GA) * 1.5f;
		Text(R.Grade, Cx + RowW * 0.5f + 110 * S, Y - 40 * S, EMcFace::Display, 120 * Sc, WithA(R.Grade == TEXT("S") ? Teal : Amber, GA), EMcAlign::Center, 4.f);
		{
			// What to chase next.
			const float T2 = R.Tip;
			FString Next;
			if (T2 < 32.f) { Next = FString::Printf(TEXT("C at $32  ·  $%.2f to go"), 32.f - T2); }
			else if (T2 < 48.f) { Next = FString::Printf(TEXT("B at $48  ·  $%.2f to go"), 48.f - T2); }
			else if (T2 < 65.f) { Next = FString::Printf(TEXT("A at $65  ·  $%.2f to go"), 65.f - T2); }
			else if (T2 < 85.f) { Next = FString::Printf(TEXT("S at $85  ·  $%.2f to go"), 85.f - T2); }
			else { Next = TEXT("TOP GRADE"); }
			const FString Hint = R.Condition < 85.f ? TEXT("brace late for feather landings") : (R.Time > 80.f ? TEXT("the stairs, the alley and the dock are faster") : TEXT("every second is a dollar"));
			Text(Next + TEXT("   ·   ") + Hint, Cx, Y + 150 * S, EMcFace::Medium, 20, WithA(Dim, GA), EMcAlign::Center, 1.f, 1.f);
		}
		if (G->bNewBest) { Text(TEXT("NEW BEST"), Cx, Y + 96 * S, EMcFace::HeavyItalic, 34, WithA(Teal, GA * (0.7f + 0.3f * FMath::Sin(Clock * 6.f))), EMcAlign::Center, 2.f, 4.f); }
		else if (G->bHasBest) { Text(FString::Printf(TEXT("BEST  $%.2f  %s"), G->Best.Tip, *G->Best.Grade), Cx, Y + 100 * S, EMcFace::Semi, 24, WithA(Dim, GA), EMcAlign::Center, 1.f, 3.f); }
		Text(TEXT("R  RIDE AGAIN"), Cx, H - 110 * S, EMcFace::Bold, 28, WithA(Teal, GA * (0.6f + 0.4f * FMath::Sin(Clock * 3.f))), EMcAlign::Center, 2.f, 5.f);
	}
}

void AMcHud::DrawSettings(AMcGameMode* G)
{
	Rect(0, 0, W, H, FLinearColor(0.f, 0.f, 0.01f, 0.78f));
	const float Cx = W * 0.5f;
	const float RowW = 760 * S;
	float Y = H * 0.07f;
	Text(TEXT("SETTINGS"), Cx, Y, EMcFace::Display, 64, Ink, EMcAlign::Center, 3.f, 6.f);
	Y += 92 * S;
	const float RowH = 34 * S;
	for (int32 i = 0; i < G->SettingsRows.Num(); ++i)
	{
		const FMcSettingRow& R = G->SettingsRows[i];
		if (!R.Section.IsEmpty())
		{
			Y += 10 * S;
			Text(R.Section, Cx - RowW * 0.5f, Y, EMcFace::Semi, 16, WithA(Amber, 0.8f), EMcAlign::Left, 0.f, 4.f);
			Y += 26 * S;
		}
		const bool bSel = G->SettingsIndex == i;
		if (bSel) { Rect(Cx - RowW * 0.5f - 14 * S, Y - 2 * S, RowW + 28 * S, RowH, FLinearColor(1.f, 0.7f, 0.22f, 0.12f)); }
		if (R.bAction)
		{
			Y += 10 * S;
			if (bSel) { Rect(Cx - RowW * 0.5f - 14 * S, Y - 2 * S, RowW + 28 * S, RowH, FLinearColor(1.f, 0.7f, 0.22f, 0.12f)); }
			Text(R.Label, Cx, Y, EMcFace::Bold, 24, bSel ? Amber : Dim, EMcAlign::Center, 1.f, 4.f);
		}
		else
		{
			Text(R.Label, Cx - RowW * 0.5f, Y, EMcFace::Medium, 23, bSel ? Ink : Dim, EMcAlign::Left, 1.f);
			const FString V = R.Value ? R.Value() : FString();
			const FString Shown = bSel ? FString::Printf(TEXT("<  %s  >"), *V) : V;
			Text(Shown, Cx + RowW * 0.5f, Y, EMcFace::Bold, 23, bSel ? Amber : Ink, EMcAlign::Right, 1.f, 1.f);
		}
		Y += RowH;
	}
	Text(TEXT("UP / DOWN  choose     LEFT / RIGHT  change     ESC / B  back"), Cx, H - 50 * S, EMcFace::Medium, 18, Dim, EMcAlign::Center, 1.f, 2.f);
	Text(FString::Printf(TEXT("%d FPS"), FMath::RoundToInt(G->MeasuredFps)), W - 30 * S, 30 * S, EMcFace::Semi, 18, Dim, EMcAlign::Right, 1.f, 2.f);
}

void AMcHud::DrawPause(AMcGameMode* G)
{
	Rect(0, 0, W, H, FLinearColor(0, 0, 0.01f, 0.6f));
	Text(TEXT("PAUSED"), W * 0.5f, H * 0.3f, EMcFace::Display, 80, Ink, EMcAlign::Center, 3.f, 6.f);
	const TCHAR* Items[] = { TEXT("RESUME"), TEXT("RESTART"), TEXT("SETTINGS"), TEXT("QUIT TO TITLE") };
	for (int32 i = 0; i < 4; ++i)
	{
		const bool bSel = G->PauseIndex == i;
		if (bSel) { Rect(W * 0.5f - 200 * S, H * 0.45f + i * 56 * S + 4 * S, 400 * S, 46 * S, FLinearColor(1.f, 0.7f, 0.22f, 0.12f)); }
		Text(Items[i], W * 0.5f, H * 0.45f + i * 56 * S, EMcFace::Bold, 34, bSel ? Amber : Dim, EMcAlign::Center, 2.f, 4.f);
	}
}
