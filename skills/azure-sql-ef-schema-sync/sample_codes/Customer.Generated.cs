// ============================================================
// Partial Class Pattern — Protect Customizations from Scaffold
// ============================================================
// Generated file (overwritten every scaffold): Models/Customer.cs
// DO NOT edit — run `dotnet ef dbcontext scaffold --force` to regenerate

public partial class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = null!;
    public string? Email { get; set; }
    public string Region { get; set; } = null!;  // newly added column
    public DateTime CreatedAt { get; set; }

    public virtual ICollection<Order> Orders { get; } = new List<Order>();
}
