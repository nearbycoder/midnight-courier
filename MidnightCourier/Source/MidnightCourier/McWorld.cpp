#include "McWorld.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/PointLightComponent.h"
#include "Components/RectLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/SpotLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/TextureCube.h"
#include "Engine/World.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "McAssets.h"
#include "McBike.h"
#include "McSettings.h"
#include "McTypes.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

AMcWorld::AMcWorld()
{
	PrimaryActorTick.bCanEverTick = true;
	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(Root);
}

void AMcWorld::BeginPlay()
{
	Super::BeginPlay();
	if (!LoadLevel())
	{
		BuildTestCourse();
	}
	BuildWeather();
}

UStaticMeshComponent* AMcWorld::AddMesh(UStaticMesh* Mesh, const FTransform& T, UMaterialInterface* Mat, bool bCollide)
{
	if (!Mesh) { return nullptr; }
	UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this);
	C->SetupAttachment(Root);
	C->SetStaticMesh(Mesh);
	C->SetWorldTransform(T);
	if (Mat) { C->SetMaterial(0, Mat); }
	C->SetCollisionEnabled(bCollide ? ECollisionEnabled::QueryOnly : ECollisionEnabled::NoCollision);
	C->SetCollisionResponseToAllChannels(ECR_Block);
	C->SetCollisionObjectType(ECC_WorldStatic);
	C->SetGenerateOverlapEvents(false);
	C->SetCanEverAffectNavigation(false);
	C->RegisterComponent();
	Meshes.Add(C);
	return C;
}

UStaticMeshComponent* AMcWorld::AddBox(const FVector& Center, const FVector& Size, const FRotator& Rot, UMaterialInterface* Mat)
{
	return AddMesh(McAssets::Mesh(TEXT("Cube")), FTransform(Rot, Center, Size / 100.f), Mat, true);
}

// ======================================================================================================
// Test course: flat lot with a kerb, kicker, a plateau with a flight of stairs, a wall and a gap.
// ======================================================================================================
void AMcWorld::BuildTestCourse()
{
	bIsTestCourse = true;
	UMaterialInterface* Ground = McAssets::Tinted(this, FLinearColor(0.05f, 0.05f, 0.055f));
	UMaterialInterface* Concrete = McAssets::Tinted(this, FLinearColor(0.22f, 0.21f, 0.2f));
	UMaterialInterface* Brick = McAssets::Tinted(this, FLinearColor(0.25f, 0.08f, 0.05f));
	UMaterialInterface* Paint = McAssets::Tinted(this, FLinearColor(0.8f, 0.6f, 0.05f));

	AddBox(FVector(15000, 0, -50), FVector(40000, 6000, 100), FRotator::ZeroRotator, Ground);
	// Side walls.
	AddBox(FVector(15000, -2200, 150), FVector(40000, 60, 300), FRotator::ZeroRotator, Brick);
	AddBox(FVector(15000, 2200, 150), FVector(40000, 60, 300), FRotator::ZeroRotator, Brick);

	// Kerb at 25 m.
	AddBox(FVector(2500, 0, 7.5f), FVector(30, 4000, 15), FRotator::ZeroRotator, Paint);
	// Sidewalk slab 40..48 m.
	AddBox(FVector(4400, 0, 7.5f), FVector(800, 4000, 15), FRotator::ZeroRotator, Concrete);

	// Long ramp up to a 3 m plateau (60..100 m), plateau 100..130 m, stairs down 130..~135 m.
	const float H = 300.f;
	{
		const float Len = 4000.f;
		const float Ang = FMath::RadiansToDegrees(FMath::Atan2(H, Len));
		const float Slope = FMath::Sqrt(Len * Len + H * H);
		AddBox(FVector(6000 + Len * 0.5f, 0, H * 0.5f - 20.f), FVector(Slope, 4000, 40), FRotator(Ang, 0, 0), Concrete);
		AddBox(FVector(11500, 0, H * 0.5f - 0.5f), FVector(3000, 4000, H), FRotator::ZeroRotator, Concrete);
		const int32 Steps = 17;
		const float Rise = H / Steps, Run = 30.f;
		for (int32 i = 0; i < Steps; ++i)
		{
			const float Top = H - Rise * (i + 1);
			AddBox(FVector(13000 + Run * (i + 0.5f), 0, Top * 0.5f), FVector(Run, 4000, FMath::Max(Top, 1.f)), FRotator::ZeroRotator, Concrete);
		}
	}

	// A kicker at 180 m (1.0 m lip), then a 6 m drop-gap test: platform 220..240 m at 2 m, gap, landing ramp.
	{
		const float Len = 400.f, Lip = 110.f;
		const int32 Seg = 8;
		for (int32 i = 0; i < Seg; ++i)
		{
			// Curved kicker from slices.
			const float A0 = (float)i / Seg, A1 = (float)(i + 1) / Seg;
			const float Z0 = Lip * A0 * A0, Z1 = Lip * A1 * A1;
			const float X0 = 18000 + Len * A0, X1 = 18000 + Len * A1;
			const float Ang = FMath::RadiansToDegrees(FMath::Atan2(Z1 - Z0, X1 - X0));
			const float L = FMath::Sqrt(FMath::Square(X1 - X0) + FMath::Square(Z1 - Z0));
			AddBox(FVector((X0 + X1) * 0.5f, 0, (Z0 + Z1) * 0.5f - 20.f), FVector(L + 2.f, 3000, 40), FRotator(Ang, 0, 0), Paint);
		}
	}
	// Drop test platforms at 220..240 m: 3 m (left) and 4.5 m (right) sheer edges.
	AddBox(FVector(23000, -900, 150), FVector(2000, 1200, 300), FRotator::ZeroRotator, Concrete);
	AddBox(FVector(23000, 900, 225), FVector(2000, 1200, 450), FRotator::ZeroRotator, Concrete);
	// Wall to bounce off at 300 m (angled).
	AddBox(FVector(30000, -1200, 150), FVector(60, 2000, 300), FRotator(0, 35, 0), Brick);
	// Lamp posts to see motion.
	for (int32 i = 0; i < 40; ++i)
	{
		AddBox(FVector(1000.f * i, -2000.f, 250.f), FVector(20, 20, 500), FRotator::ZeroRotator, Concrete);
		AddBox(FVector(1000.f * i + 500.f, 2000.f, 250.f), FVector(20, 20, 500), FRotator::ZeroRotator, Concrete);
	}

	StartPos = FVector(-1000.f, 0.f, 0.f);
	StartYaw = 0.f;
	FMcGate G;
	G.Name = TEXT("Plateau"); G.Pos = FVector(11500, 0, 300); G.Radius = 2000.f;
	Checkpoints.Add(G);
	GoalPos = FVector(32000.f, 0.f, 0.f);
	GoalRadius = 400.f;
	FMcGate Goal; Goal.Name = TEXT("Drop-off"); Goal.Pos = GoalPos; Goal.Radius = GoalRadius; Goal.HalfWidth = GoalRadius;
	Checkpoints.Add(Goal);
	TArray<FMcRoutePoint>& R = Routes.Add(TEXT("main"));
	for (float X : { 0.f, 2400.f, 5000.f, 10000.f, 12900.f, 14000.f, 17000.f, 18400.f, 26000.f, 32000.f })
	{
		FMcRoutePoint P; P.Pos = FVector(X, 0, 0); P.Speed = 12.f; R.Add(P);
	}
}

// ======================================================================================================
// Level from the Blender city generator
// ======================================================================================================
namespace
{
	FVector V3(const TArray<TSharedPtr<FJsonValue>>& A, int32 Offset = 0)
	{
		return FVector(A[Offset]->AsNumber(), A[Offset + 1]->AsNumber(), A[Offset + 2]->AsNumber());
	}
	FLinearColor Col(const TArray<TSharedPtr<FJsonValue>>& A)
	{
		return FLinearColor(A[0]->AsNumber(), A[1]->AsNumber(), A[2]->AsNumber());
	}
}

bool AMcWorld::LoadLevel()
{
	if (FParse::Param(FCommandLine::Get(), TEXT("McTestCourse"))) { return false; }
	const FString Path = FPaths::ProjectContentDir() / TEXT("Courier/Data/level.json");
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *Path)) { return false; }
	TSharedPtr<FJsonObject> J;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) || !J.IsValid()) { return false; }

	AMcBike::Water.Reset();
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("water")))
	{
		const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
		AMcBike::FWater W;
		W.Area = FBox2D(FVector2D(FMath::Min(A[0]->AsNumber(), A[2]->AsNumber()), FMath::Min(A[1]->AsNumber(), A[3]->AsNumber())),
			FVector2D(FMath::Max(A[0]->AsNumber(), A[2]->AsNumber()), FMath::Max(A[1]->AsNumber(), A[3]->AsNumber())));
		W.Z = A[4]->AsNumber();
		AMcBike::Water.Add(W);
		WaterZ = FMath::Max(WaterZ, (float)W.Z);
	}
	{
		const TSharedPtr<FJsonObject> S = J->GetObjectField(TEXT("start"));
		StartPos = V3(S->GetArrayField(TEXT("pos")));
		StartYaw = S->GetNumberField(TEXT("yaw"));
	}
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("checkpoints")))
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		FMcGate G;
		G.Name = O->GetStringField(TEXT("name"));
		G.Pos = V3(O->GetArrayField(TEXT("pos")));
		G.Yaw = O->GetNumberField(TEXT("yaw"));
		G.Radius = O->GetNumberField(TEXT("radius"));
		G.HalfWidth = O->HasField(TEXT("halfwidth")) ? O->GetNumberField(TEXT("halfwidth")) : G.Radius;
		Checkpoints.Add(G);
	}
	if (Checkpoints.Num() > 0)
	{
		GoalPos = Checkpoints.Last().Pos;
		GoalYaw = Checkpoints.Last().Yaw;
		GoalRadius = Checkpoints.Last().Radius;
	}

	// Static geometry chunks (one mesh each, placed at the origin).
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("chunks")))
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		const FString Name = O->GetStringField(TEXT("mesh"));
		const bool bCollide = O->GetBoolField(TEXT("collide"));
		UStaticMeshComponent* C = AddMesh(McAssets::Mesh(*Name), FTransform::Identity, nullptr, bCollide);
		if (!C) { UE_LOG(LogMc, Warning, TEXT("Missing chunk %s"), *Name); continue; }
		C->SetMobility(EComponentMobility::Static);
		if (O->HasField(TEXT("shadow")) && !O->GetBoolField(TEXT("shadow"))) { C->SetCastShadow(false); }
	}

	// Instanced props.
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("props")))
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		const FString Name = O->GetStringField(TEXT("mesh"));
		UStaticMesh* Mesh = McAssets::Mesh(*Name);
		if (!Mesh) { UE_LOG(LogMc, Warning, TEXT("Missing prop %s"), *Name); continue; }
		UInstancedStaticMeshComponent* I = NewObject<UInstancedStaticMeshComponent>(this);
		I->SetupAttachment(Root);
		I->SetStaticMesh(Mesh);
		const bool bCollide = O->GetBoolField(TEXT("collide"));
		I->SetCollisionEnabled(bCollide ? ECollisionEnabled::QueryOnly : ECollisionEnabled::NoCollision);
		I->SetCollisionObjectType(ECC_WorldStatic);
		I->SetCollisionResponseToAllChannels(ECR_Block);
		I->SetCanEverAffectNavigation(false);
		I->SetMobility(EComponentMobility::Static);
		if (O->HasField(TEXT("shadow")) && !O->GetBoolField(TEXT("shadow"))) { I->SetCastShadow(false); }
		if (O->HasField(TEXT("cull"))) { I->SetCullDistances(0, O->GetNumberField(TEXT("cull"))); }
		I->RegisterComponent();
		TArray<FTransform> Ts;
		for (const TSharedPtr<FJsonValue>& T : O->GetArrayField(TEXT("items")))
		{
			const TArray<TSharedPtr<FJsonValue>>& A = T->AsArray();
			const FVector P = V3(A, 0);
			const FRotator R(A.Num() > 5 ? A[5]->AsNumber() : 0.0, A[3]->AsNumber(), A.Num() > 6 ? A[6]->AsNumber() : 0.0);
			const float S = A.Num() > 4 ? A[4]->AsNumber() : 1.0;
			Ts.Add(FTransform(R, P, FVector(S)));
		}
		I->AddInstances(Ts, false, true);
	}

	// Lights.
	int32 NumShadow = 0;
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("lights")))
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		const FString Kind = O->GetStringField(TEXT("kind"));
		const FVector P = V3(O->GetArrayField(TEXT("pos")));
		const FLinearColor C = Col(O->GetArrayField(TEXT("color")));
		const float Intensity = O->GetNumberField(TEXT("intensity"));
		const float Radius = O->GetNumberField(TEXT("radius"));
		const bool bShadow = O->GetBoolField(TEXT("shadow"));
		ULocalLightComponent* L = nullptr;
		if (Kind == TEXT("spot"))
		{
			USpotLightComponent* S = NewObject<USpotLightComponent>(this);
			const TArray<TSharedPtr<FJsonValue>>& Cone = O->GetArrayField(TEXT("cone"));
			S->SetInnerConeAngle(Cone[0]->AsNumber());
			S->SetOuterConeAngle(Cone[1]->AsNumber());
			L = S;
		}
		else if (Kind == TEXT("rect"))
		{
			URectLightComponent* R = NewObject<URectLightComponent>(this);
			const TArray<TSharedPtr<FJsonValue>>& Sz = O->GetArrayField(TEXT("size"));
			R->SetSourceWidth(Sz[0]->AsNumber());
			R->SetSourceHeight(Sz[1]->AsNumber());
			R->SetBarnDoorAngle(60.f);
			L = R;
		}
		else
		{
			UPointLightComponent* Pt = NewObject<UPointLightComponent>(this);
			Pt->SetSourceRadius(O->HasField(TEXT("source")) ? O->GetNumberField(TEXT("source")) : 10.f);
			L = Pt;
		}
		L->SetupAttachment(Root);
		L->SetMobility(EComponentMobility::Movable);
		L->SetWorldLocation(P);
		if (O->HasField(TEXT("rot")))
		{
			const FVector R = V3(O->GetArrayField(TEXT("rot")));
			L->SetWorldRotation(FRotator(R.X, R.Y, R.Z));
		}
		L->SetIntensityUnits(ELightUnits::Candelas);
		L->SetIntensity(Intensity);
		L->SetLightColor(C);
		L->SetAttenuationRadius(Radius);
		L->SetCastShadows(bShadow);
		if (bShadow) { ++NumShadow; }
		L->SetVolumetricScatteringIntensity(O->HasField(TEXT("fog")) ? O->GetNumberField(TEXT("fog")) : 1.f);
		L->RegisterComponent();
	}

	// Autopilot / ghost-guide routes.
	const TSharedPtr<FJsonObject> RoutesObj = J->GetObjectField(TEXT("routes"));
	for (const auto& Pair : RoutesObj->Values)
	{
		TArray<FMcRoutePoint>& R = Routes.Add(FString(*Pair.Key));
		for (const TSharedPtr<FJsonValue>& P : Pair.Value->AsArray())
		{
			const TArray<TSharedPtr<FJsonValue>>& A = P->AsArray();
			FMcRoutePoint RP;
			RP.Pos = V3(A, 0);
			RP.Speed = A[3]->AsNumber();
			const int32 Flags = A.Num() > 4 ? (int32)A[4]->AsNumber() : 0;
			RP.bBrace = (Flags & 1) != 0;
			RP.bHop = (Flags & 2) != 0;
			R.Add(RP);
		}
	}

	// Minimap strokes.
	if (J->HasField(TEXT("map")))
	{
		for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("map")))
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			TArray<FVector2D> Pts;
			for (const TSharedPtr<FJsonValue>& P : O->GetArrayField(TEXT("pts")))
			{
				const TArray<TSharedPtr<FJsonValue>>& A = P->AsArray();
				Pts.Add(FVector2D(A[0]->AsNumber(), A[1]->AsNumber()));
				MapBounds += Pts.Last();
			}
			MapLines.Add(Pts);
			MapLineKinds.Add((int32)O->GetNumberField(TEXT("kind")));
		}
	}

	UE_LOG(LogMc, Display, TEXT("MC_LEVEL chunks=%d checkpoints=%d routes=%d shadowlights=%d"), Meshes.Num(), Checkpoints.Num(), Routes.Num(), NumShadow);
	return true;
}

// ======================================================================================================
// Weather, sky, light
// ======================================================================================================
void AMcWorld::BuildWeather()
{
	Moon = NewObject<UDirectionalLightComponent>(this);
	Moon->SetupAttachment(Root);
	Moon->SetMobility(EComponentMobility::Movable);
	Moon->SetWorldRotation(FRotator(-38.f, 125.f, 0.f));
	Moon->SetIntensity(0.06f);
	Moon->SetLightColor(FLinearColor(0.55f, 0.65f, 1.f));
	Moon->SetCastShadows(true);
	Moon->SetVolumetricScatteringIntensity(0.5f);
	Moon->RegisterComponent();

	Sky = NewObject<USkyLightComponent>(this);
	Sky->SetupAttachment(Root);
	Sky->SetMobility(EComponentMobility::Movable);
	Sky->SourceType = ESkyLightSourceType::SLS_SpecifiedCubemap;
	Sky->bRealTimeCapture = false;
	Sky->SetIntensity(0.25f);
	Sky->SetLightColor(FLinearColor(0.35f, 0.42f, 0.6f));
	Sky->bLowerHemisphereIsBlack = false;
	Sky->RegisterComponent();
	if (UTextureCube* Cube = LoadObject<UTextureCube>(nullptr, TEXT("/Engine/EngineResources/GrayLightTextureCube.GrayLightTextureCube"), nullptr, LOAD_NoWarn | LOAD_Quiet))
	{
		Sky->SetCubemap(Cube);
	}
	Sky->RecaptureSky();

	Fog = NewObject<UExponentialHeightFogComponent>(this);
	Fog->SetupAttachment(Root);
	Fog->SetWorldLocation(FVector(StartPos.X, StartPos.Y, WaterZ > -50000.f ? WaterZ : 0.f));
	Fog->SetFogDensity(0.035f);
	Fog->SetFogHeightFalloff(0.06f);
	Fog->SetFogInscatteringColor(FLinearColor(0.04f, 0.05f, 0.075f));
	Fog->SetVolumetricFog(true);
	Fog->SetVolumetricFogScatteringDistribution(0.55f);
	Fog->SetVolumetricFogAlbedo(FColor(200, 210, 230));
	Fog->SetVolumetricFogExtinctionScale(1.4f);
	Fog->SetVolumetricFogDistance(9000.f);
	Fog->SetStartDistance(200.f);
	Fog->RegisterComponent();

	// Sky dome: a huge sphere seen from inside.
	if (UMaterialInterface* SkyMat = McAssets::Material(TEXT("M_Sky")))
	{
		SkyMID = UMaterialInstanceDynamic::Create(SkyMat, this);
		SkyDome = AddMesh(McAssets::Mesh(TEXT("Sphere")), FTransform(FRotator::ZeroRotator, StartPos, FVector(4000.f)), SkyMID, false);
		SkyDome->SetCastShadow(false);
		SkyDome->bAffectDistanceFieldLighting = false;
		SkyDome->SetAffectDynamicIndirectLighting(false);
	}

	// Rain: a box of streak instances that the material scrolls and wraps around the camera.
	if (UStaticMesh* Streak = McAssets::Mesh(TEXT("SM_RainStreaks")))
	{
		Rain = NewObject<UInstancedStaticMeshComponent>(this);
		Rain->SetupAttachment(Root);
		Rain->SetStaticMesh(Streak);
		Rain->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Rain->SetCastShadow(false);
		Rain->SetMobility(EComponentMobility::Movable);
		Rain->bAffectDistanceFieldLighting = false;
		Rain->SetAffectDynamicIndirectLighting(false);
		Rain->SetTranslucentSortPriority(10);
		Rain->RegisterComponent();
		Rain->AddInstance(FTransform::Identity, true);
		Rain->SetBoundsScale(2.f);
		if (UMaterialInterface* RM = McAssets::Material(TEXT("M_Rain")))
		{
			RainMID = UMaterialInstanceDynamic::Create(RM, this);
			Rain->SetMaterial(0, RainMID);
		}
	}
	if (UStaticMesh* Ripples = McAssets::Mesh(TEXT("SM_RainSplashes")))
	{
		Splashes = NewObject<UInstancedStaticMeshComponent>(this);
		Splashes->SetupAttachment(Root);
		Splashes->SetStaticMesh(Ripples);
		Splashes->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Splashes->SetCastShadow(false);
		Splashes->SetMobility(EComponentMobility::Movable);
		Splashes->RegisterComponent();
		Splashes->AddInstance(FTransform::Identity, true);
		Splashes->SetBoundsScale(100.f);
	}
	if (UStaticMesh* BeamMesh = McAssets::Mesh(TEXT("SM_Beacon")))
	{
		Beacon = AddMesh(BeamMesh, FTransform(FRotator::ZeroRotator, GoalPos, FVector(1.f)), nullptr, false);
		Beacon->SetCastShadow(false);
		Beacon->bAffectDistanceFieldLighting = false;
	}
}

void AMcWorld::SetFocus(const FVector& CameraPos, const FVector& Velocity)
{
	Focus = CameraPos;
	FocusVel = Velocity;
}

void AMcWorld::SetGoalActive(bool bActive)
{
	bGoalActive = bActive;
	if (Beacon) { Beacon->SetVisibility(bActive); }
}

void AMcWorld::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	// The rain box rides with the camera (the material wraps streaks inside it), led slightly by velocity
	// so you ride into the rain rather than out of it.
	const FVector Lead = FocusVel * 0.25f;
	if (Rain) { Rain->SetWorldLocation(Focus + Lead); }
	if (Splashes) { Splashes->SetWorldLocation(FVector(Focus.X + Lead.X, Focus.Y + Lead.Y, 0.f)); }
	if (SkyDome) { SkyDome->SetWorldLocation(Focus); }
	if (RainMID)
	{
		RainMID->SetVectorParameterValue(TEXT("CamVel"), FLinearColor(FocusVel.X, FocusVel.Y, FocusVel.Z, 0.f));
		RainMID->SetVectorParameterValue(TEXT("LampPos"), FLinearColor(LampPos.X, LampPos.Y, LampPos.Z, 0.f));
		RainMID->SetVectorParameterValue(TEXT("LampDir"), FLinearColor(LampDir.X, LampDir.Y, LampDir.Z, 0.f));
	}
	if (SkyMID) { SkyMID->SetScalarParameterValue(TEXT("Lightning"), Lightning); }

	// Lightning: rare, far away; a flash of the moon light and the sky, thunder seconds later.
	NextLightning -= DeltaSeconds;
	if (NextLightning <= 0.f)
	{
		Lightning = 1.f;
		NextLightning = FMath::FRandRange(18.f, 40.f);
		bThunderPending = true;
		ThunderDelay = FMath::FRandRange(1.2f, 3.5f);
	}
	if (Lightning > 0.f)
	{
		const float Flicker = (FMath::Frac(GetWorld()->GetTimeSeconds() * 13.f) > 0.4f) ? 1.f : 0.35f;
		Lightning = FMath::Max(0.f, Lightning - DeltaSeconds * 2.2f);
		if (Moon) { Moon->SetIntensity(0.06f + 2.5f * Lightning * Flicker); }
	}
	else if (Moon)
	{
		Moon->SetIntensity(0.06f);
	}
}

void AMcWorld::ApplyPostProcess(FPostProcessSettings& PP) const
{
	static float ExposureBias = [] { float B = 0.f; FParse::Value(FCommandLine::Get(), TEXT("McExposure="), B); return B; }();
	PP.bOverride_AutoExposureMethod = true;
	PP.AutoExposureMethod = EAutoExposureMethod::AEM_Manual;
	PP.bOverride_AutoExposureBias = true;
	PP.AutoExposureBias = ExposureBias;
	PP.bOverride_AutoExposureApplyPhysicalCameraExposure = true;
	PP.AutoExposureApplyPhysicalCameraExposure = false;

	PP.bOverride_BloomIntensity = true; PP.BloomIntensity = 0.9f;
	PP.bOverride_BloomThreshold = true; PP.BloomThreshold = 0.6f;
	PP.bOverride_VignetteIntensity = true; PP.VignetteIntensity = 0.55f;
	PP.bOverride_SceneFringeIntensity = true; PP.SceneFringeIntensity = 0.35f;
	PP.bOverride_FilmGrainIntensity = true; PP.FilmGrainIntensity = 0.12f;
	PP.bOverride_MotionBlurAmount = true; PP.MotionBlurAmount = FMcSettings::Get().bMotionBlur ? 0.2f : 0.f;
	PP.bOverride_MotionBlurMax = true; PP.MotionBlurMax = 3.f;

	// Grade: teal shadows, sodium highlights.
	PP.bOverride_ColorSaturation = true; PP.ColorSaturation = FVector4(1.0f, 1.0f, 1.05f, 1.05f);
	PP.bOverride_ColorGammaShadows = true; PP.ColorGammaShadows = FVector4(0.92f, 1.0f, 1.08f, 1.f);
	PP.bOverride_ColorGainHighlights = true; PP.ColorGainHighlights = FVector4(1.06f, 1.0f, 0.92f, 1.f);
	PP.bOverride_ColorContrast = true; PP.ColorContrast = FVector4(1.08f, 1.08f, 1.08f, 1.f);
	PP.bOverride_ToneCurveAmount = true; PP.ToneCurveAmount = 1.f;

	PP.bOverride_LumenFinalGatherQuality = true; PP.LumenFinalGatherQuality = 1.f;
	PP.bOverride_LumenSceneLightingQuality = true; PP.LumenSceneLightingQuality = 1.f;
	PP.bOverride_LumenReflectionQuality = true; PP.LumenReflectionQuality = 1.f;
	PP.bOverride_LumenMaxTraceDistance = true; PP.LumenMaxTraceDistance = 12000.f;
	PP.bOverride_LumenSceneViewDistance = true; PP.LumenSceneViewDistance = 15000.f;
	PP.bOverride_LumenMaxRoughnessToTraceReflections = true; PP.LumenMaxRoughnessToTraceReflections = 0.6f;

	if (Lightning > 0.f)
	{
		PP.AutoExposureBias += Lightning * 0.8f;
	}
}
